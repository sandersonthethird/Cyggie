import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { decideSummaryDisplay } from '../../lib/meetings/summary-display'

// Feature flag — Item 2 Summary tab. Off by default until spot-checks on
// rendered summaries confirm the markdown lib + ErrorBoundary fallback
// behave as expected in prod. Read inline at JS-bundle time (matches the
// GATEWAY_URL pattern in mobile/lib/api/recordings.ts).
const SUMMARY_TAB_ENABLED =
  process.env['EXPO_PUBLIC_FEATURE_SUMMARY_TAB'] === '1'
import {
  deleteMeeting,
  enhanceMeeting,
  fetchMeeting,
  fetchTemplates,
  type MeetingDetail,
  type MeetingLinkedCompany,
  type MeetingLinkedContact,
  type SummaryTemplate,
  type TranscriptSegment,
} from '../../lib/api/meetings'
import { EnhanceModal } from '../../components/EnhanceModal'
import { useAuthStore } from '../../lib/auth/store'
import { MeetingStatusPill } from '../../components/MeetingStatusPill'
import { NotesEditor } from '../../components/NotesEditor'
import { NotesConflictModal, type ConflictPayload } from '../../components/NotesConflictModal'
import { subscribeToConflicts } from '../../lib/sync/conflict-bus'
import { rememberLastYours } from '../../lib/sync/boot'
import { tick as tickClock } from '../../lib/sync/clock'
import { enqueue } from '../../lib/sync/outbox'
import { drainNow } from '../../lib/sync/agent'
import {
  discardPendingUploadFileByMeetingId,
  loadPendingUploadByMeetingId,
  type PendingUpload,
} from '../../lib/recording/pending-upload'
import { retryPendingUpload } from '../../lib/recording/session'
import { colors, radii, spacing, type } from '../../theme'

// Meeting detail — third entity in the read-only CRM triangle.
//
// Shape mirrors Company / Contact detail (hero + stats + segmented).
// Segments are Overview / Transcript / People.
//
// Overview shows: notes + linked companies (as chips → /companies/:id) +
//                 attendees list (display-name + email) + meeting platform/URL.
// Transcript shows: a flat list of segments with speaker labels.
// People shows: linked contacts (via speaker_contact_links) → /contacts/:id.

type Segment = 'overview' | 'transcript' | 'summary' | 'people'

export default function MeetingDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const signOut = useAuthStore((s) => s.signOut)
  const [segment, setSegment] = useState<Segment>('overview')
  const queryClient = useQueryClient()
  const [conflict, setConflict] = useState<ConflictPayload | null>(null)

  const query = useQuery({
    queryKey: ['meetings', 'detail', id],
    queryFn: ({ signal }) => fetchMeeting(id, { signal }),
    enabled: id.length > 0,
    staleTime: 30_000,
  })

  // Enhance UI state. Only relevant when SUMMARY_TAB_ENABLED, but the
  // hooks have to run unconditionally to satisfy rules-of-hooks.
  const [enhanceModalOpen, setEnhanceModalOpen] = useState(false)
  const [enhanceSubmitting, setEnhanceSubmitting] = useState(false)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const enhanceMountedRef = useRef(true)
  useEffect(() => {
    return () => {
      enhanceMountedRef.current = false
    }
  }, [])

  // Templates fetched once and cached an hour (rarely change).
  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
    enabled: SUMMARY_TAB_ENABLED && id.length > 0,
    staleTime: 60 * 60 * 1000,
  })

  const onEnhanceClick = useCallback(() => {
    if (enhanceSubmitting) return
    setEnhanceError(null)
    setEnhanceModalOpen(true)
  }, [enhanceSubmitting])

  const onEnhanceSelectTemplate = useCallback(
    (templateId: string) => {
      if (!id || enhanceSubmitting) return
      setEnhanceModalOpen(false)
      setEnhanceSubmitting(true)
      setEnhanceError(null)
      // 75s client-side timeout — gateway's own AbortSignal fires at 60s,
      // mobile pads to 75s so the upstream timeout always wins and we
      // surface a clean CHAT_TIMEOUT rather than a bare AbortError.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 75_000)
      void (async () => {
        try {
          await enhanceMeeting(id, { templateId }, { signal: controller.signal })
          if (!enhanceMountedRef.current) return
          // Force a refetch so SummarySection rerenders with the new content.
          await queryClient.invalidateQueries({ queryKey: ['meetings', 'detail', id] })
        } catch (err) {
          if (!enhanceMountedRef.current) return
          const msg =
            err instanceof ApiError
              ? err.code === 'NO_TRANSCRIPT'
                ? 'No transcript yet — wait for transcription to finish, then try again.'
                : err.code === 'CHAT_UNAVAILABLE'
                  ? 'No Anthropic API key configured. Paste one in desktop Settings → AI & Transcription.'
                  : err.code === 'CHAT_TIMEOUT'
                    ? 'Enhance took too long. Long transcripts can push past 60s — try again, or summarize on desktop where streaming is supported.'
                    : err.message
              : err instanceof Error && err.name === 'AbortError'
                ? 'Enhance took too long on your device. Try again.'
                : 'Could not enhance. Try again.'
          setEnhanceError(msg)
        } finally {
          clearTimeout(timeout)
          if (enhanceMountedRef.current) setEnhanceSubmitting(false)
        }
      })()
    },
    [id, enhanceSubmitting, queryClient],
  )

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  // Subscribe to sync conflicts for THIS meeting only — other meeting
  // conflicts will be picked up when the user navigates to them.
  useEffect(() => {
    if (!id) return
    return subscribeToConflicts((event) => {
      if (event.meetingId !== id) return
      setConflict({
        meetingId: event.meetingId,
        yours: event.yours,
        theirs: event.theirs,
      })
      // Refetch so the UI reflects the server's authoritative state.
      void queryClient.invalidateQueries({ queryKey: ['meetings', 'detail', id] })
    })
  }, [id, queryClient])

  const onChangeEnqueued = (next: string | null) => {
    rememberLastYours(id, next)
  }

  const onReplaceTheirs = (yours: string | null) => {
    // Re-PATCH with a fresh lamport — guaranteed > server's because the
    // pull/merge after the 409 catches us up to the server's lamport, and
    // tickClock() returns server+1+.
    const lamport = tickClock()
    enqueue({
      op: 'meeting.notes.update',
      resourceId: id,
      payload: { notes: yours, lamport },
    })
    setConflict(null)
    void drainNow()
  }
  const onDiscardBoth = (_theirs: string | null) => {
    // Server already has `theirs`; nothing to enqueue. Just clear local
    // state and let the next refetch repopulate the editor.
    setConflict(null)
    void queryClient.invalidateQueries({ queryKey: ['meetings', 'detail', id] })
  }
  const onKeepYoursLocally = () => {
    // Leave it on screen for the user — next keystroke will enqueue with
    // a fresh lamport (server-merged via the agent's 200 path).
    setConflict(null)
  }

  const meeting = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {meeting?.title ?? ''}
          </Text>
          <View style={styles.backBtn} />
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => query.refetch()}
            tintColor={colors.crimson}
          />
        }
      >
        {query.isLoading && !meeting ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !meeting ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : meeting ? (
          <>
            <Hero meeting={meeting} />
            <StatsCard meeting={meeting} />
            {meeting.isGroupEvent && <GroupEventBanner />}
            {meeting.status === 'scheduled' && <RecordCTA meeting={meeting} />}
            {meeting.status === 'empty' && <EmptyTranscriptBanner meetingId={meeting.id} />}
            {meeting.status === 'error' && <RetryUploadBanner meetingId={meeting.id} />}
            <TerminalCleanupSideEffect meetingStatus={meeting.status} meetingId={meeting.id} />
            <SegmentControl value={segment} onChange={setSegment} />
            {segment === 'overview' && (
              <OverviewSection meeting={meeting} onChangeEnqueued={onChangeEnqueued} />
            )}
            {segment === 'transcript' && (
              <TranscriptSection
                segments={meeting.transcriptSegments}
                hasTranscript={meeting.hasTranscript}
              />
            )}
            {segment === 'summary' && SUMMARY_TAB_ENABLED && (
              <SummarySection
                summary={meeting.summary}
                status={meeting.status}
                onEnhanceClick={onEnhanceClick}
                submitting={enhanceSubmitting}
                enhanceError={enhanceError}
              />
            )}
            {segment === 'people' && (
              <PeopleSection contacts={meeting.linkedContacts} />
            )}
            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
      <NotesConflictModal
        payload={conflict}
        onReplaceTheirs={onReplaceTheirs}
        onKeepYours={onKeepYoursLocally}
        onDiscardBoth={onDiscardBoth}
        onDismiss={onKeepYoursLocally}
      />
      {SUMMARY_TAB_ENABLED && (
        <EnhanceModal
          open={enhanceModalOpen}
          templates={templatesQuery.data ?? []}
          isLoading={templatesQuery.isLoading}
          hasExistingSummary={Boolean(meeting?.summary)}
          onSelect={onEnhanceSelectTemplate}
          onDismiss={() => setEnhanceModalOpen(false)}
        />
      )}
    </View>
  )
}

function Hero({ meeting }: { meeting: MeetingDetail }) {
  return (
    <View style={styles.hero}>
      <View style={styles.heroAvatar}>
        <Ionicons
          name={meeting.wasImpromptu ? 'flash' : 'calendar'}
          size={28}
          color={colors.crimson}
        />
      </View>
      <Text style={styles.heroName} numberOfLines={3}>
        {meeting.title}
      </Text>
      <Text style={styles.heroSubtitle}>{formatDateLong(meeting.date)}</Text>
      <View style={styles.heroPillRow}>
        <MeetingStatusPill status={meeting.status} />
      </View>
      {meeting.meetingUrl && (
        <View style={styles.heroLinks}>
          <LinkChip
            icon="videocam-outline"
            label={meeting.meetingPlatform ?? 'Join'}
            onPress={() => void Linking.openURL(meeting.meetingUrl!)}
          />
        </View>
      )}
    </View>
  )
}

function LinkChip({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.linkChip, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={14} color={colors.text2} />
      <Text style={styles.linkChipText}>{label}</Text>
    </Pressable>
  )
}

function StatsCard({ meeting }: { meeting: MeetingDetail }) {
  // Pre-transcript states (scheduled / error / empty) lack actual duration
  // + speaker data. Use the scheduled slot length when available;
  // otherwise render a 2-cell layout that just shows Status. Avoids the
  // "— / Scheduled / —" placeholder look.
  if (!meeting.hasTranscript) {
    const rawSlot = meeting.scheduledEndAt
      ? Math.round(
          (Date.parse(meeting.scheduledEndAt) - Date.parse(meeting.date)) / 60_000,
        )
      : NaN
    // Number.isFinite guard prevents NaN reaching the rendered string in
    // the corner case where scheduledEndAt is malformed.
    const slotMin = Number.isFinite(rawSlot) ? Math.max(1, rawSlot) : null
    return (
      <View style={styles.statsCard}>
        {slotMin !== null && (
          <>
            <StatCell label="Duration" value={`${slotMin} min`} />
            <View style={styles.statDivider} />
          </>
        )}
        <StatCell label="Status" value={humanize(meeting.status)} />
      </View>
    )
  }
  // Transcribed rows (post-Deepgram) keep the existing 3-cell layout.
  return (
    <View style={styles.statsCard}>
      <StatCell
        label="Duration"
        value={meeting.durationSeconds ? formatDuration(meeting.durationSeconds) : '—'}
      />
      <View style={styles.statDivider} />
      <StatCell label="Status" value={humanize(meeting.status)} />
      <View style={styles.statDivider} />
      <StatCell
        label="Speakers"
        value={meeting.speakerCount > 0 ? String(meeting.speakerCount) : '—'}
      />
    </View>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

/**
 * T5 — "Record" CTA for scheduled meetings. Tapping navigates to /record
 * with the meeting's calendarEventId + title as query params, so the
 * resulting upload finds-or-updates this row via /recordings/upload's
 * (userId, calEventId) find-or-update path. Avoids the previous
 * "go back to Calendar, hit the FAB, get an impromptu meeting instead"
 * dance the E2E run surfaced.
 *
 * Renders nothing when calendarEventId is null (impromptu-created
 * scheduled rows shouldn't get this CTA — no calendar event to
 * associate with).
 */
function RecordCTA({ meeting }: { meeting: MeetingDetail }) {
  if (!meeting.calendarEventId) return null
  const onPress = () => {
    const params = new URLSearchParams({
      calEventId: meeting.calendarEventId!,
      title: meeting.title,
    })
    router.push(`/record?${params.toString()}` as never)
  }
  return (
    <View style={styles.recordCta}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.recordCtaBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Start recording this meeting"
      >
        <Ionicons name="mic" size={18} color="#fff" />
        <Text style={styles.recordCtaText}>Start recording</Text>
      </Pressable>
    </View>
  )
}

function GroupEventBanner() {
  return (
    <View style={styles.groupEventBanner}>
      <Ionicons name="information-circle-outline" size={18} color={colors.text2} />
      <View style={styles.groupEventBannerText}>
        <Text style={styles.groupEventBannerTitle}>
          Group event — attendees not added to CRM
        </Text>
        <Text style={styles.groupEventBannerSubtitle}>Toggle from desktop</Text>
      </View>
    </View>
  )
}

// Shown when the meeting completed transcription but Deepgram detected 0
// utterances — the recording was effectively silent. Lets the user discard
// (hard-delete from gateway) or keep (dismiss the banner; meeting stays in
// the calendar list, presumably for later manual cleanup from desktop).
function EmptyTranscriptBanner({ meetingId }: { meetingId: string }) {
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (dismissed) return null
  const onDiscard = async () => {
    if (busy) return
    setBusy(true)
    try {
      await deleteMeeting(meetingId)
      router.replace('/(tabs)/calendar')
    } catch {
      // If the delete fails (network blip, etc.), just leave the banner
      // visible so the user can retry. We don't surface a toast here in
      // V1 to keep scope minimal — they can pull-to-refresh and try again.
      setBusy(false)
    }
  }
  return (
    <View style={styles.emptyTranscriptBanner}>
      <Ionicons name="mic-off-outline" size={18} color={colors.text2} />
      <View style={styles.groupEventBannerText}>
        <Text style={styles.groupEventBannerTitle}>No speech detected</Text>
        <Text style={styles.groupEventBannerSubtitle}>
          The recording may have been silent or too quiet.
        </Text>
      </View>
      <Pressable
        onPress={onDiscard}
        disabled={busy}
        style={({ pressed }) => [styles.emptyBannerBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Discard empty meeting"
      >
        <Text style={styles.emptyBannerBtnText}>Discard</Text>
      </Pressable>
      <Pressable
        onPress={() => setDismissed(true)}
        style={({ pressed }) => [styles.emptyBannerLink, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Keep meeting"
      >
        <Text style={styles.emptyBannerLinkText}>Keep</Text>
      </Pressable>
    </View>
  )
}

/**
 * Shown when a backgrounded recording's transcription errored AND the
 * local audio file is still in MMKV (the safety net). Lets the user
 * re-upload from the local file (creates a new meeting) and auto-deletes
 * the errored row so they're not left with a duplicate.
 *
 * Renders nothing when there is no local file to retry from — that
 * case is the same as any other terminal error: the failure is visible
 * via the StatusPill in the Hero, but recovery requires re-recording.
 */
function RetryUploadBanner({ meetingId }: { meetingId: string }) {
  const userId = useAuthStore((s) => s.userId)
  const [pending, setPending] = useState<PendingUpload | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!userId) return
    setPending(loadPendingUploadByMeetingId(meetingId, userId))
  }, [meetingId, userId])
  if (pending === undefined) return null // initial load — render nothing this tick
  if (!pending) return null // no local backup; nothing this banner can do

  const onRetry = async () => {
    if (busy) return
    setBusy(true)
    setErrMsg(null)
    try {
      await retryPendingUpload(pending)
      // Best-effort delete of the errored meeting so the calendar list
      // isn't left with a duplicate of the same recording. If this fails
      // (network blip / gateway down) the new meeting still exists; the
      // user can manually discard the old one later.
      try {
        await deleteMeeting(meetingId)
      } catch {
        // ignore; user can manually discard later
      }
      router.replace('/(tabs)/calendar')
    } catch (err) {
      setBusy(false)
      setErrMsg(err instanceof Error ? err.message : 'Retry failed')
    }
  }

  const onDiscard = async () => {
    if (busy) return
    if (!userId) return
    setBusy(true)
    try {
      // Wipe the local file + MMKV slot first, then ask the gateway to
      // delete the meeting row. We do MMKV first so a gateway failure
      // doesn't strand the local file forever.
      await discardPendingUploadFileByMeetingId(meetingId, userId)
      try {
        await deleteMeeting(meetingId)
      } catch {
        // ignore — local cleanup already happened
      }
      router.replace('/(tabs)/calendar')
    } catch {
      setBusy(false)
    }
  }

  return (
    <View style={styles.emptyTranscriptBanner}>
      <Ionicons name="cloud-upload-outline" size={18} color={colors.text2} />
      <View style={styles.groupEventBannerText}>
        <Text style={styles.groupEventBannerTitle}>Transcription failed</Text>
        <Text style={styles.groupEventBannerSubtitle}>
          {errMsg ?? 'Your recording is still on this phone — tap to retry.'}
        </Text>
      </View>
      <Pressable
        onPress={onRetry}
        disabled={busy}
        style={({ pressed }) => [styles.emptyBannerBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Retry upload"
      >
        <Text style={styles.emptyBannerBtnText}>Retry</Text>
      </Pressable>
      <Pressable
        onPress={onDiscard}
        style={({ pressed }) => [styles.emptyBannerLink, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Discard recording"
      >
        <Text style={styles.emptyBannerLinkText}>Discard</Text>
      </Pressable>
    </View>
  )
}

/**
 * Side-effect-only component: when the user opens a meeting that has
 * already reached a terminal status (transcribed / empty) and there's
 * still a local pendingUpload entry for it, silently discard the entry.
 * This closes the cleanup loop for backgrounded recordings whose poll
 * never ran to terminal — eventually the user opens the meeting from
 * the calendar list and we reap the orphaned audio file at that moment.
 * Renders nothing.
 */
function TerminalCleanupSideEffect({
  meetingStatus,
  meetingId,
}: {
  meetingStatus: string
  meetingId: string
}) {
  const userId = useAuthStore((s) => s.userId)
  useEffect(() => {
    if (meetingStatus !== 'transcribed' && meetingStatus !== 'empty') return
    if (!userId) return
    // Fire-and-forget; the entry might not exist (most common case) —
    // discardPendingUploadFileByMeetingId is a no-op then.
    void discardPendingUploadFileByMeetingId(meetingId, userId)
  }, [meetingStatus, meetingId, userId])
  return null
}

function SegmentControl({
  value,
  onChange,
}: {
  value: Segment
  onChange: (s: Segment) => void
}) {
  // Item 2 — Summary tab appears between Transcript and People when the
  // EXPO_PUBLIC_FEATURE_SUMMARY_TAB flag is on. Keeping order stable
  // matters so muscle memory doesn't break when the flag flips.
  const items: Array<{ key: Segment; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'transcript', label: 'Transcript' },
    ...(SUMMARY_TAB_ENABLED
      ? ([{ key: 'summary', label: 'Summary' }] as const)
      : []),
    { key: 'people', label: 'People' },
  ]
  return (
    <View style={styles.segmentWrap}>
      {items.map((it) => {
        const active = it.key === value
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(it.key)}
            style={[styles.segmentBtn, active && styles.segmentBtnActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {it.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function OverviewSection({
  meeting,
  onChangeEnqueued,
}: {
  meeting: MeetingDetail
  onChangeEnqueued?: (next: string | null) => void
}) {
  return (
    <View style={styles.section}>
      <NotesEditor
        meetingId={meeting.id}
        status={meeting.status}
        serverNotes={meeting.notes}
        serverUpdatedAt={meeting.updatedAt}
        serverLamport={meeting.lamport}
        onChangeEnqueued={onChangeEnqueued}
      />

      {meeting.linkedCompanies.length > 0 && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Companies</Text>
          <View style={styles.chipRow}>
            {meeting.linkedCompanies.map((c) => (
              <CompanyPill key={c.id} company={c} />
            ))}
          </View>
        </View>
      )}

      {meeting.attendees && meeting.attendees.length > 0 && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>
            Attendees ({meeting.attendees.length})
          </Text>
          {meeting.attendees.map((name, idx) => (
            <Text key={idx} style={styles.attendeeText}>
              {name}
              {meeting.attendeeEmails?.[idx]
                ? `  ·  ${meeting.attendeeEmails[idx]}`
                : ''}
            </Text>
          ))}
        </View>
      )}

    </View>
  )
}

function CompanyPill({ company }: { company: MeetingLinkedCompany }) {
  return (
    <Pressable
      onPress={() => router.push(`/companies/${company.id}`)}
      style={({ pressed }) => [styles.companyPill, pressed && styles.pressed]}
    >
      <Ionicons name="business-outline" size={12} color={colors.crimson} />
      <Text style={styles.companyPillText} numberOfLines={1}>
        {company.name}
      </Text>
    </Pressable>
  )
}

function TranscriptSection({
  segments,
  hasTranscript,
}: {
  segments: TranscriptSegment[]
  hasTranscript: boolean
}) {
  if (!hasTranscript || segments.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>No transcript for this meeting.</Text>
      </View>
    )
  }
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {segments.map((seg, idx) => (
          <View key={idx}>
            <View style={styles.segmentBlock}>
              <View style={styles.segmentHeaderRow}>
                <Text style={styles.segmentSpeaker}>
                  {seg.speakerLabel ?? `Speaker ${seg.speaker + 1}`}
                </Text>
                <Text style={styles.segmentTime}>
                  {formatTime(seg.startTime)}
                </Text>
              </View>
              <Text style={styles.segmentText}>{seg.text}</Text>
            </View>
            {idx < segments.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

// Item 2 — Summary tab.
//
// Three empty states based on (status, summary) — chosen so the user
// knows whether to wait (transcribing), generate (transcribed but no
// summary yet), or that they're looking at the real content.
//
//   status='transcribing'           → "Summary will be ready once
//                                      transcription completes."
//   status terminal && summary null → Enhance CTA (NEW — was "open on
//                                      desktop"; now mobile can trigger).
//   summary present                 → Re-enhance pill + markdown render.
//
// Enhance flow is delegated to the parent via onEnhanceClick + submitting
// + enhanceError props; this component is presentation-only.
//
// Wrapped in <ErrorBoundary> so a malformed markdown payload (e.g.
// unbalanced fence, weird mathy chars) can't white-screen the whole
// meeting detail. Fallback copy nudges the user toward the desktop.
function SummarySection({
  summary,
  status,
  onEnhanceClick,
  submitting,
  enhanceError,
}: {
  summary: string | null
  status: string
  onEnhanceClick: () => void
  submitting: boolean
  enhanceError: string | null
}) {
  const display = decideSummaryDisplay({ summary, status })

  if (display.kind === 'transcribing-wait') {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>
          Summary will be ready once transcription completes.
        </Text>
      </View>
    )
  }

  if (display.kind === 'empty') {
    return (
      <View style={styles.section}>
        <View style={styles.emptyEnhanceWrap}>
          <Text style={styles.emptyInline}>
            No summary yet. Enhance to generate one with Cyggie.
          </Text>
          <EnhanceButton
            label="Enhance"
            submitting={submitting}
            onPress={onEnhanceClick}
          />
          {enhanceError && <Text style={styles.enhanceErrorText}>{enhanceError}</Text>}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.reEnhanceRow}>
        <EnhanceButton
          label="Re-enhance"
          submitting={submitting}
          onPress={onEnhanceClick}
          compact
        />
      </View>
      {enhanceError && <Text style={styles.enhanceErrorText}>{enhanceError}</Text>}
      <View style={styles.kvCard}>
        <View style={styles.summaryBlock}>
          <ErrorBoundary
            fallback={() => (
              <Text style={styles.emptyInline}>
                Couldn't render summary — open on desktop.
              </Text>
            )}
          >
            <Markdown style={summaryMarkdownStyles}>{display.markdown}</Markdown>
          </ErrorBoundary>
        </View>
      </View>
    </View>
  )
}

function EnhanceButton({
  label,
  submitting,
  onPress,
  compact,
}: {
  label: string
  submitting: boolean
  onPress: () => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} summary`}
      onPress={onPress}
      disabled={submitting}
      style={({ pressed }) => [
        styles.enhanceBtn,
        compact && styles.enhanceBtnCompact,
        submitting && styles.enhanceBtnDisabled,
        pressed && !submitting && styles.enhanceBtnPressed,
      ]}
    >
      {submitting ? (
        <ActivityIndicator size="small" color={colors.surface} />
      ) : (
        <>
          <Ionicons name="sparkles" size={compact ? 12 : 14} color={colors.surface} />
          <Text style={[styles.enhanceBtnLabel, compact && styles.enhanceBtnLabelCompact]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  )
}

function PeopleSection({ contacts }: { contacts: MeetingLinkedContact[] }) {
  if (contacts.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>
          No speakers tagged as contacts yet.
        </Text>
      </View>
    )
  }
  // Stable sort by speakerIndex so the order matches the transcript flow.
  const sorted = useMemo(
    () => [...contacts].sort((a, b) => a.speakerIndex - b.speakerIndex),
    [contacts],
  )
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {sorted.map((c, idx) => (
          <View key={c.id}>
            <Pressable
              onPress={() => router.push(`/contacts/${c.id}`)}
              style={({ pressed }) => [styles.personRow, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={c.fullName}
            >
              <View style={styles.personAvatar}>
                <Text style={styles.personAvatarText}>{initials(c.fullName)}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.personName} numberOfLines={1}>
                  {c.fullName}
                </Text>
                <Text style={styles.personMeta} numberOfLines={1}>
                  {c.title ? `${c.title}  ·  ` : ''}Speaker {c.speakerIndex + 1}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.text4} />
            </Pressable>
            {idx < sorted.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Could not load meeting'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Meeting failed to load</Text>
      <Text style={styles.errorMessage}>{message}</Text>
      <Pressable
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

function humanize(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDateLong(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

function formatTime(seconds: number): string {
  // mm:ss or h:mm:ss depending on length.
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  topbarTitle: {
    flex: 1,
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },

  scroll: { backgroundColor: colors.bg, paddingBottom: spacing.xxl },

  hero: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  heroAvatar: {
    width: 60,
    height: 60,
    borderRadius: radii.pill,
    backgroundColor: colors.crimsonMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  heroName: {
    color: colors.text,
    fontSize: type.h1,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.4,
  },
  heroSubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 4,
    textAlign: 'center',
  },
  heroPillRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  heroLinks: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.md,
  },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface3,
    borderRadius: radii.pill,
  },
  linkChipText: { color: colors.text2, fontSize: type.bodyTight, fontWeight: '500' },

  statsCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
  },

  groupEventBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface3,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recordCta: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  recordCtaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.crimson,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
  },
  recordCtaText: {
    color: '#FFFFFF',
    fontSize: type.body + 1,
    fontWeight: '600',
  },
  groupEventBannerText: { flex: 1 },
  groupEventBannerTitle: {
    color: colors.text,
    fontSize: type.bodyTight,
    fontWeight: '500',
  },
  groupEventBannerSubtitle: {
    color: colors.text3,
    fontSize: type.caption,
    marginTop: 2,
  },
  emptyTranscriptBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface3,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyBannerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.crimson,
  },
  emptyBannerBtnText: {
    color: colors.crimson,
    fontSize: type.caption,
    fontWeight: '600',
  },
  emptyBannerLink: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  emptyBannerLinkText: {
    color: colors.text3,
    fontSize: type.caption,
    fontWeight: '500',
  },
  statCell: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 4,
  },
  statValue: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  statLabel: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 2,
  },

  segmentWrap: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface3,
    borderRadius: radii.md,
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: radii.sm + 2,
  },
  segmentBtnActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  segmentTextActive: { color: colors.text },

  section: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },

  descBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  descHeading: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  descText: {
    color: colors.text2,
    fontSize: type.body + 1,
    lineHeight: 21,
  },
  attendeeText: {
    color: colors.text2,
    fontSize: type.body,
    paddingVertical: 3,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  companyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  companyPillText: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '600',
    maxWidth: 200,
  },

  kvCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kvDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },

  segmentBlock: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  summaryBlock: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  emptyEnhanceWrap: {
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  reEnhanceRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: spacing.sm,
  },
  enhanceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.crimson,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 36,
  },
  enhanceBtnCompact: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    minHeight: 26,
  },
  enhanceBtnDisabled: {
    backgroundColor: colors.text4,
  },
  enhanceBtnPressed: {
    opacity: 0.8,
  },
  enhanceBtnLabel: {
    color: colors.surface,
    fontSize: type.body,
    fontWeight: '600',
  },
  enhanceBtnLabelCompact: {
    fontSize: type.caption,
  },
  enhanceErrorText: {
    color: colors.crimson,
    fontSize: type.caption,
    marginBottom: spacing.sm,
  },
  segmentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  segmentSpeaker: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '700',
  },
  segmentTime: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '500',
  },

  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  rowPressed: { backgroundColor: colors.surface3 },
  personAvatar: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personAvatarText: {
    color: colors.text2,
    fontSize: 13,
    fontWeight: '700',
  },
  personName: {
    color: colors.text,
    fontSize: type.body + 1,
    fontWeight: '600',
  },
  personMeta: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 2,
  },

  emptyInline: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },

  center: { paddingVertical: 60, alignItems: 'center', justifyContent: 'center' },
  errorTitle: {
    color: colors.crimson,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  errorMessage: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  retry: {
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
  },
  retryText: { color: colors.text, fontSize: type.bodyTight, fontWeight: '500' },
  pressed: { opacity: 0.6 },

  // Note: the `type` keyword on this property collides with the imported `type`
  // alias from theme. Renamed `segmentText` accordingly when used.
})

// Avoid shadowing `type` from theme.
// (Style key `segmentText` above refers to RN style; theme.type is the import.)

// Markdown theme for SummarySection. react-native-markdown-display takes
// a style record keyed by markdown-it element names (heading1, paragraph,
// code_inline, etc.) — we override only the typography to match the rest
// of the meeting-detail surface. Everything else falls back to library
// defaults.
const summaryMarkdownStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: type.body + 1, lineHeight: 22 },
  heading1: {
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  heading2: {
    color: colors.text,
    fontSize: type.h2 - 2,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  heading3: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  paragraph: { marginTop: 6, marginBottom: 6 },
  bullet_list: { marginTop: 4, marginBottom: 4 },
  ordered_list: { marginTop: 4, marginBottom: 4 },
  list_item: { marginVertical: 2 },
  code_inline: {
    backgroundColor: colors.surface3,
    color: colors.text,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: type.body,
  },
  fence: {
    backgroundColor: colors.surface3,
    color: colors.text,
    padding: spacing.sm,
    borderRadius: radii.sm,
    fontSize: type.bodyTight,
  },
  link: { color: colors.crimson },
  strong: { fontWeight: '700', color: colors.text },
})
