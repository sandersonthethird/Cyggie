import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { useFocusEffect } from '@react-navigation/native'
import { ApiError } from '../../lib/api/client'
import { meetingDetailRefetchInterval } from '../../lib/meetings/in-progress'
import {
  classifyLocation,
  extractLocationUrl,
  extractPhoneNumber,
} from '@cyggie/shared/location-classifier'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { KeyboardAvoidingScreen } from '../../components/KeyboardAvoidingScreen'
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
  linkCompanyToMeeting,
  unlinkCompanyFromMeeting,
  updateMeetingAttendees,
  type AttendeeContact,
  type MeetingDetail,
  type MeetingLinkedCompany,
  type SummaryTemplate,
  type TranscriptSegment,
} from '../../lib/api/meetings'
import type { ContactListItem } from '../../lib/api/contacts'
import type { CompanyListItem } from '../../lib/api/companies'
import { ContactPicker } from '../../components/ContactPicker'
import { CompanyPicker } from '../../components/CompanyPicker'
import { CompanyLogo } from '../../components/CompanyLogo'
import { attendeeLabel } from '../../lib/attendee'
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
import { cancelRecording, retryPendingUpload, startRecording, stopRecording } from '../../lib/recording/session'
import { useRecordingStore } from '../../lib/recording/store'
import { formatElapsed } from '../../lib/recording/format-elapsed'
import { clearNotesDraft } from '../../components/NotesEditor'
import {
  clearMeetingConfirmed,
  isMeetingConfirmed,
  onMeetingConfirmed,
} from '../../lib/recording/confirmed-meetings'
import { RichMarkdown } from '../../lib/markdown'
import { colors, radii, spacing, type } from '../../theme'

// Meeting detail — third entity in the read-only CRM triangle.
//
// Shape mirrors Company / Contact detail (hero + stats + segmented).
// Segments are Overview / Transcript.
//
// Overview shows: notes + linked companies (as chips → /companies/:id) +
//                 attendees list (display-name + email) + meeting platform/URL.
// Transcript shows: a flat list of segments with speaker labels.

type Segment = 'overview' | 'transcript' | 'summary'

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
    // Keep the optimistic record (seeded by start-impromptu) on screen when a
    // fetch 404s — offline, or during the brief pre-create window — so the
    // meeting view never blanks while it's the active local recording.
    placeholderData: keepPreviousData,
    // While the meeting is still recording/transcribing, repoll so the status
    // pill flips to "transcribed" live — without the user having to leave the
    // screen and come back. Stops once the server reaches a terminal status.
    refetchInterval: (q) => meetingDetailRefetchInterval(q.state.data?.status),
    refetchIntervalInBackground: false,
  })

  // Refetch when the screen regains focus so any change made elsewhere while
  // we were away (a desktop-added summary, edited notes, a status flip we
  // missed) is reflected on return. Complements the in-progress poll above:
  // the poll covers "changing while I watch", this covers "changed while I
  // was gone". refetch() is a no-op when the query is disabled (empty id).
  useFocusEffect(
    useCallback(() => {
      void query.refetch()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
  )

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

  // ── Recording state ─────────────────────────────────────────────────────
  // Live-recording UI is gated on the STORE (this device is recording into
  // this meeting), never on the server status string — a row can read
  // status='recording' merely because it's uploaded-awaiting-Deepgram.
  const recStatus = useRecordingStore((s) => s.status)
  const activeMeetingId = useRecordingStore((s) => s.activeMeetingId)
  const startedAt = useRecordingStore((s) => s.startedAt)
  const discardOnCancel = useRecordingStore((s) => s.discardOnCancel)
  const isRecordingThis = recStatus === 'recording' && activeMeetingId === id

  // serverConfirmed drives whether notes enqueue (vs buffer) and whether
  // tagging is enabled. A meeting we're NOT actively recording is, by
  // definition, confirmed on the gateway (you reached it via a real fetch or
  // after upload). While recording, it's confirmed once pre-create/upload ran.
  const [confirmed, setConfirmed] = useState(() => isMeetingConfirmed(id))
  useEffect(() => {
    setConfirmed(isMeetingConfirmed(id))
    return onMeetingConfirmed((mid) => {
      if (mid === id) setConfirmed(true)
    })
  }, [id])
  const serverConfirmed = confirmed || !isRecordingThis

  const onStopRecording = useCallback(async () => {
    if (!meeting) return
    try {
      await stopRecording({
        title: meeting.title,
        meetingId: meeting.id,
        calEventId: meeting.calendarEventId ?? undefined,
      })
      // Stay on this screen — the in-progress poll flips status to transcribed;
      // an upload failure surfaces via RetryUploadBanner (status==='error').
    } catch {
      // stopRecording already called markError; the banner/RetryUploadBanner
      // reflects it. Nothing else to do.
    }
  }, [meeting])

  const onStartRecordingHere = useCallback(async () => {
    if (!meeting) return
    try {
      await startRecording({
        meetingId: meeting.id,
        title: meeting.title,
        calEventId: meeting.calendarEventId ?? undefined,
        discardOnCancel: false, // scheduled row predates us — Cancel won't delete it
      })
    } catch (err) {
      Alert.alert(
        'Microphone unavailable',
        err instanceof Error ? err.message : 'Could not start recording',
      )
    }
  }, [meeting])

  const onCancelRecording = useCallback(async () => {
    const { meetingId: cancelledId } = await cancelRecording()
    if (cancelledId) {
      clearNotesDraft(cancelledId)
      clearMeetingConfirmed(cancelledId)
      queryClient.removeQueries({ queryKey: ['meetings', 'detail', cancelledId] })
      // Impromptu rows were pre-created on the gateway — delete so an accidental
      // tap leaves nothing behind. Best-effort; the 12h no-audio sweeper backstops.
      if (discardOnCancel) {
        try {
          await deleteMeeting(cancelledId)
        } catch {
          // ignore — sweeper cleans up
        }
      }
    }
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/calendar')
  }, [discardOnCancel, queryClient])

  return (
    <KeyboardAvoidingScreen style={styles.root}>
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
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
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
        ) : query.error && !meeting && !isRecordingThis ? (
          // Suppress the load error while this meeting is the active local
          // recording — the optimistic record carries the screen, and the
          // poll's 404s (offline / pre-create window) are expected.
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : meeting ? (
          <>
            <Hero meeting={meeting} />
            {isRecordingThis && (
              <RecordingBanner startedAt={startedAt} onStop={onStopRecording} onCancel={onCancelRecording} />
            )}
            <StatsCard meeting={meeting} />
            {meeting.isGroupEvent && <GroupEventBanner />}
            {!isRecordingThis && (
              <MeetingActionsRow meeting={meeting} onStartRecording={onStartRecordingHere} />
            )}
            {meeting.status === 'empty' && <EmptyTranscriptBanner meetingId={meeting.id} />}
            {meeting.status === 'error' && <RetryUploadBanner meetingId={meeting.id} />}
            <TerminalCleanupSideEffect meetingStatus={meeting.status} meetingId={meeting.id} />
            <SegmentControl value={segment} onChange={setSegment} />
            {segment === 'overview' && (
              <OverviewSection
                meeting={meeting}
                onChangeEnqueued={onChangeEnqueued}
                serverConfirmed={serverConfirmed}
              />
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
    </KeyboardAvoidingScreen>
  )
}

function Hero({ meeting }: { meeting: MeetingDetail }) {
  const joinLinkExpired = useJoinLinkExpired(meeting.scheduledEndAt)
  // First linked company drives the Hero avatar so the meeting visually
  // identifies with the most relevant org. Falls back to the original
  // crimson icon (flash / calendar) for meetings with no company attached.
  const primaryCompany = meeting.linkedCompanies[0]
  return (
    <View style={styles.hero}>
      {primaryCompany ? (
        <CompanyLogo
          domain={primaryCompany.primaryDomain}
          name={primaryCompany.name}
          size={60}
          shape="pill"
          style={styles.heroLogo}
        />
      ) : (
        <View style={styles.heroAvatar}>
          <Ionicons
            name={meeting.wasImpromptu ? 'flash' : 'calendar'}
            size={28}
            color={colors.crimson}
          />
        </View>
      )}
      <Text style={styles.heroName} numberOfLines={3}>
        {meeting.title}
      </Text>
      <Text style={styles.heroSubtitle}>{formatDateLong(meeting.date)}</Text>
      <View style={styles.heroPillRow}>
        <MeetingStatusPill status={meeting.status} />
      </View>
      <ConferencingChip meeting={meeting} joinLinkExpired={joinLinkExpired} />
    </View>
  )
}

// Drives the Hero's conferencing chip off the calendar `location` field.
// Google auto-attaches a Meet link to most events, so meeting.meetingUrl
// alone can't tell an in-person meeting from a video one — classifyLocation
// disambiguates the overloaded `location` text:
//   in_person → "In person" → Google Maps
//   phone     → "Call"      → tel: (never "In person")
//   video     → the URL in `location`, else fall through to meetingUrl
//   none      → the existing meetingUrl / platform chip
function ConferencingChip({
  meeting,
  joinLinkExpired,
}: {
  meeting: MeetingDetail
  joinLinkExpired: boolean
}) {
  const kind = classifyLocation(meeting.location)

  if (kind === 'in_person') {
    const loc = meeting.location ?? ''
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`
    return (
      <View style={styles.heroLinks}>
        <LinkChip
          icon="location-outline"
          label="In person"
          onPress={() => openExternal(mapsUrl, 'Location', loc)}
        />
      </View>
    )
  }

  if (kind === 'phone') {
    const phone = extractPhoneNumber(meeting.location)
    return (
      <View style={styles.heroLinks}>
        <LinkChip
          icon="call-outline"
          label="Call"
          disabled={!phone}
          onPress={() =>
            phone && openExternal(`tel:${phone}`, 'Call', meeting.location ?? '')
          }
        />
      </View>
    )
  }

  // video class: prefer the URL embedded in `location`, else the meetingUrl.
  const videoUrl = kind === 'video' ? extractLocationUrl(meeting.location) : null
  const url = videoUrl ?? meeting.meetingUrl
  if (!url) return null
  return (
    <View style={styles.heroLinks}>
      <LinkChip
        icon="videocam-outline"
        label={meeting.meetingPlatform ?? 'Join'}
        disabled={joinLinkExpired}
        onPress={() => openExternal(url, meeting.meetingPlatform ?? 'Meeting link', url)}
      />
    </View>
  )
}

// Meeting join links go inactive 5 minutes after the scheduled end so a
// stale Zoom/Meet URL can't be tapped mid-next-call. Null end (impromptu,
// or malformed) leaves the link active — we have no signal to gate on.
const JOIN_LINK_GRACE_MS = 5 * 60_000
// setTimeout silently clamps delays above ~2^31 ms to 1 (firing immediately),
// which would mark a far-future meeting as expired. Skip the timer when the
// expiry is further out than this — next remount will re-evaluate.
const MAX_TIMEOUT_MS = 2_147_000_000

function useJoinLinkExpired(scheduledEndAt: string | null): boolean {
  const expiryMs =
    scheduledEndAt !== null ? Date.parse(scheduledEndAt) + JOIN_LINK_GRACE_MS : NaN
  const [expired, setExpired] = useState(
    () => Number.isFinite(expiryMs) && Date.now() >= expiryMs,
  )
  useEffect(() => {
    if (!Number.isFinite(expiryMs)) return
    const remaining = expiryMs - Date.now()
    if (remaining <= 0) {
      setExpired(true)
      return
    }
    setExpired(false)
    if (remaining > MAX_TIMEOUT_MS) return
    const timer = setTimeout(() => setExpired(true), remaining)
    return () => clearTimeout(timer)
  }, [expiryMs])
  return expired
}

function LinkChip({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.linkChip,
        disabled && styles.linkChipDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={14} color={disabled ? colors.text4 : colors.text2} />
      <Text style={[styles.linkChipText, disabled && styles.linkChipTextDisabled]}>
        {label}
      </Text>
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
 * "Record" CTA for scheduled meetings. Starts recording IN PLACE — the meeting
 * view itself becomes the recording surface (timer + Stop via RecordingBanner),
 * so the user keeps seeing notes / companies / attendees. No longer navigates
 * to the /record takeover screen.
 *
 * Renders nothing when calendarEventId is null (impromptu-created scheduled
 * rows shouldn't get this CTA — no calendar event to associate with).
 */
function RecordCTA({ meeting, onPress }: { meeting: MeetingDetail; onPress: () => void }) {
  if (!meeting.calendarEventId) return null
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.recordCtaBtn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Start recording this meeting"
    >
      <Ionicons name="mic" size={18} color="#fff" />
      <Text style={styles.recordCtaText}>Start recording</Text>
    </Pressable>
  )
}

/**
 * RecordingBanner — shown on the meeting view while THIS meeting is actively
 * recording on this device. Pulsing dot + live timer + Stop + Cancel. The
 * user can scroll/edit notes below it; the floating bubble takes over when
 * they navigate away.
 */
function RecordingBanner({
  startedAt,
  onStop,
  onCancel,
}: {
  startedAt: number | null
  onStop: () => void
  onCancel: () => void
}) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const h = setInterval(tick, 1000)
    return () => clearInterval(h)
  }, [startedAt])

  const confirmCancel = () => {
    Alert.alert('Discard this recording?', 'The recording and meeting will be deleted.', [
      { text: 'Keep recording', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onCancel },
    ])
  }

  return (
    <View style={styles.recBanner}>
      <View style={styles.recDot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.recLabel}>Recording</Text>
        <Text style={styles.recTimer}>{formatElapsed(elapsed)}</Text>
      </View>
      <Pressable
        onPress={onStop}
        style={({ pressed }) => [styles.recStopBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Stop recording"
      >
        <View style={styles.recStopSquare} />
        <Text style={styles.recStopText}>Stop</Text>
      </Pressable>
      <Pressable
        onPress={confirmCancel}
        hitSlop={8}
        style={({ pressed }) => [styles.recCancelLink, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Cancel recording"
      >
        <Text style={styles.recCancelText}>Cancel</Text>
      </Pressable>
    </View>
  )
}

/**
 * T17b — "Chat about this meeting" CTA. Gated on the meeting having
 * *something* worth asking about: a transcript, the user's notes, or a
 * persisted summary. Pure-stub scheduled rows (status='scheduled', no
 * content yet) don't get this CTA — there's nothing to ground a
 * conversation in, and the user would just hit the empty-context branch
 * of the gateway's context-builder.
 */
function meetingHasContent(meeting: MeetingDetail): boolean {
  if (meeting.hasTranscript) return true
  if (meeting.notes && meeting.notes.trim().length > 0) return true
  if (meeting.summary && meeting.summary.trim().length > 0) return true
  return false
}

function ChatCTA({ meeting }: { meeting: MeetingDetail }) {
  if (!meetingHasContent(meeting)) return null
  const onPress = () => {
    router.push({
      pathname: '/chat/[contextKind]/[contextId]',
      params: {
        contextKind: 'meeting',
        contextId: `meeting:${meeting.id}`,
        label: meeting.title,
      },
    })
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chatCtaBtn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Chat about this meeting"
    >
      <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.crimson} />
      <Text style={styles.chatCtaText}>Chat</Text>
    </Pressable>
  )
}

/**
 * Single horizontal action band shared by Record + Chat. Each child is
 * independently conditional; whichever ones render flex evenly.
 * Returns null when neither would render so we don't leave an empty
 * row taking up vertical space above the segment control.
 */
function MeetingActionsRow({
  meeting,
  onStartRecording,
}: {
  meeting: MeetingDetail
  onStartRecording: () => void
}) {
  const showRecord = meeting.status === 'scheduled' && Boolean(meeting.calendarEventId)
  const showChat = meetingHasContent(meeting)
  if (!showRecord && !showChat) return null
  return (
    <View style={styles.actionsRow}>
      {showRecord && (
        <View style={styles.actionsRowItem}>
          <RecordCTA meeting={meeting} onPress={onStartRecording} />
        </View>
      )}
      {showChat && (
        <View style={styles.actionsRowItem}>
          <ChatCTA meeting={meeting} />
        </View>
      )}
    </View>
  )
}

function GroupEventBanner() {
  return (
    <View style={styles.groupEventBanner}>
      <Ionicons name="information-circle-outline" size={18} color={colors.text2} />
      <View style={styles.groupEventBannerText}>
        <Text style={styles.groupEventBannerTitle}>
          Excluded from CRM — attendees not added as contacts
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
  // Item 2 — Summary tab appears after Transcript when the
  // EXPO_PUBLIC_FEATURE_SUMMARY_TAB flag is on. Keeping order stable
  // matters so muscle memory doesn't break when the flag flips.
  const items: Array<{ key: Segment; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'transcript', label: 'Transcript' },
    ...(SUMMARY_TAB_ENABLED
      ? ([{ key: 'summary', label: 'Summary' }] as const)
      : []),
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
  serverConfirmed,
}: {
  meeting: MeetingDetail
  onChangeEnqueued?: (next: string | null) => void
  /** False only for an impromptu meeting whose gateway row isn't confirmed yet
   *  (offline pre-record). Notes still buffer; tagging is disabled until the
   *  row exists (tagging needs a live gateway round-trip). */
  serverConfirmed: boolean
}) {
  const queryClient = useQueryClient()
  const [contactPickerOpen, setContactPickerOpen] = useState(false)
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Tagging requires the row to exist on the gateway. Disabled while unconfirmed.
  const taggingDisabled = busy || !serverConfirmed

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['meetings', 'detail', meeting.id] })
  }, [queryClient, meeting.id])

  // The gateway exposes attendees as the enriched `attendeeContacts` array;
  // the raw parallel JSONB arrays (`attendees` + `attendeeEmails`) live on
  // the meeting row itself but aren't included in the read response shape.
  // We reconstruct them from attendeeContacts — they index-align by
  // construction (gateway side: see meetings.ts:254 map).
  const currentAttendeeNames = meeting.attendeeContacts.map((a) => a.name)
  const currentAttendeeEmails = meeting.attendeeContacts.map((a) => a.email ?? '')

  // Add attendee: append to the parallel attendee arrays + PATCH. Dedupe
  // by email when present (case-insensitive); contacts without an email
  // dedupe by exact-name match. Matches the desktop EntityPicker filter
  // posture.
  const addAttendee = useCallback(
    async (contact: ContactListItem) => {
      setContactPickerOpen(false)
      setBusy(true)
      try {
        const newName = contact.fullName
        const newEmail = contact.email ?? ''
        const dupByEmail =
          newEmail &&
          currentAttendeeEmails.some((e) => e.toLowerCase() === newEmail.toLowerCase())
        const dupByName =
          !newEmail &&
          currentAttendeeNames.some((n) => n.toLowerCase() === newName.toLowerCase())
        if (dupByEmail || dupByName) {
          return // already on the meeting; no-op
        }
        await updateMeetingAttendees(
          meeting.id,
          [...currentAttendeeNames, newName],
          [...currentAttendeeEmails, newEmail],
        )
        refresh()
      } catch (err) {
        Alert.alert('Failed to add attendee', err instanceof Error ? err.message : 'Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [meeting.id, currentAttendeeNames, currentAttendeeEmails, refresh],
  )

  const removeAttendeeAt = useCallback(
    async (index: number) => {
      if (index < 0 || index >= currentAttendeeNames.length) return
      setBusy(true)
      try {
        await updateMeetingAttendees(
          meeting.id,
          currentAttendeeNames.filter((_, i) => i !== index),
          currentAttendeeEmails.filter((_, i) => i !== index),
        )
        refresh()
      } catch (err) {
        Alert.alert('Failed to remove attendee', err instanceof Error ? err.message : 'Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [meeting.id, currentAttendeeNames, currentAttendeeEmails, refresh],
  )

  const addCompany = useCallback(
    async (company: CompanyListItem) => {
      setCompanyPickerOpen(false)
      setBusy(true)
      try {
        await linkCompanyToMeeting(meeting.id, company.id)
        refresh()
      } catch (err) {
        Alert.alert('Failed to link company', err instanceof Error ? err.message : 'Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [meeting.id, refresh],
  )

  const removeCompany = useCallback(
    async (companyId: string) => {
      setBusy(true)
      try {
        await unlinkCompanyFromMeeting(meeting.id, companyId)
        refresh()
      } catch (err) {
        Alert.alert('Failed to unlink company', err instanceof Error ? err.message : 'Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [meeting.id, refresh],
  )

  // Long-press handlers ask for confirmation before removing.
  const confirmRemoveAttendee = (label: string, index: number): void => {
    Alert.alert(`Remove ${label}?`, 'They will no longer appear as an attendee on this meeting.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeAttendeeAt(index) },
    ])
  }
  const confirmRemoveCompany = (company: MeetingLinkedCompany): void => {
    Alert.alert(`Unlink ${company.name}?`, 'This company will no longer be linked to this meeting.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlink', style: 'destructive', onPress: () => void removeCompany(company.id) },
    ])
  }

  return (
    <View style={styles.section}>
      <NotesEditor
        meetingId={meeting.id}
        status={meeting.status}
        serverNotes={meeting.notes}
        serverUpdatedAt={meeting.updatedAt}
        serverLamport={meeting.lamport}
        onChangeEnqueued={onChangeEnqueued}
        serverConfirmed={serverConfirmed}
      />

      {!serverConfirmed && (
        <Text style={styles.offlineTagHint}>
          Connect to tag companies and attendees. Your notes are saved and will sync.
        </Text>
      )}

      <View style={styles.descBlock}>
        <View style={styles.descRowHeader}>
          <Text style={styles.descHeading}>
            Companies
            {meeting.linkedCompanies.length > 0 ? ` (${meeting.linkedCompanies.length})` : ''}
          </Text>
          <Pressable
            onPress={() => setCompanyPickerOpen(true)}
            disabled={taggingDisabled}
            hitSlop={8}
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed, taggingDisabled && { opacity: 0.5 }]}
            accessibilityLabel="Link company"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={18} color={colors.crimson} />
          </Pressable>
        </View>
        {meeting.linkedCompanies.length > 0 ? (
          <>
            <View style={styles.chipRow}>
              {meeting.linkedCompanies.map((c) => (
                <CompanyPill
                  key={c.id}
                  company={c}
                  onLongPress={() => confirmRemoveCompany(c)}
                />
              ))}
            </View>
            <Text style={styles.pillHint}>Long-press to unlink.</Text>
          </>
        ) : (
          <Text style={styles.descEmpty}>No companies linked. Tap + to add one.</Text>
        )}
      </View>

      <View style={styles.descBlock}>
        <View style={styles.descRowHeader}>
          <Text style={styles.descHeading}>
            Attendees
            {meeting.attendeeContacts.length > 0 ? ` (${meeting.attendeeContacts.length})` : ''}
          </Text>
          <Pressable
            onPress={() => setContactPickerOpen(true)}
            disabled={taggingDisabled}
            hitSlop={8}
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed, taggingDisabled && { opacity: 0.5 }]}
            accessibilityLabel="Add attendee"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={18} color={colors.crimson} />
          </Pressable>
        </View>
        {meeting.attendeeContacts.length > 0 ? (
          <>
            <View style={styles.chipRow}>
              {meeting.attendeeContacts.map((a, idx) => (
                <AttendeePill
                  key={`${a.email ?? a.name}-${idx}`}
                  attendee={a}
                  onLongPress={() => confirmRemoveAttendee(attendeeLabel(a), idx)}
                />
              ))}
            </View>
            <Text style={styles.pillHint}>Long-press to remove.</Text>
          </>
        ) : (
          <Text style={styles.descEmpty}>No attendees yet. Tap + to add one.</Text>
        )}
      </View>

      <ContactPicker
        open={contactPickerOpen}
        onClose={() => setContactPickerOpen(false)}
        onPick={addAttendee}
      />
      <CompanyPicker
        open={companyPickerOpen}
        onClose={() => setCompanyPickerOpen(false)}
        onPick={addCompany}
      />
    </View>
  )
}

function CompanyPill({
  company,
  onLongPress,
}: {
  company: MeetingLinkedCompany
  /** Long-press → confirm + remove. Tap navigates to the company detail. */
  onLongPress?: () => void
}) {
  return (
    <Pressable
      onPress={() => router.push(`/companies/${company.id}`)}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => [styles.companyPill, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={
        onLongPress ? `${company.name} (long-press to unlink)` : company.name
      }
    >
      <CompanyLogo
        domain={company.primaryDomain}
        name={company.name}
        size={16}
        shape="rounded"
      />
      <Text style={styles.companyPillText} numberOfLines={1}>
        {company.name}
      </Text>
    </Pressable>
  )
}

function AttendeePill({
  attendee,
  onLongPress,
}: {
  attendee: AttendeeContact
  /** Long-press → confirm + remove. Tap navigates to the contact when one
   *  is resolved; for name-only attendees (no contactId) tap is inert. */
  onLongPress?: () => void
}) {
  const label = attendeeLabel(attendee)
  const hasContact = Boolean(attendee.contactId)
  const contactId = attendee.contactId
  if (hasContact && contactId) {
    return (
      <Pressable
        onPress={() => router.push(`/contacts/${contactId}`)}
        onLongPress={onLongPress}
        delayLongPress={400}
        style={({ pressed }) => [styles.attendeePill, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={onLongPress ? `${label} (long-press to remove)` : label}
      >
        <Ionicons name="person-outline" size={12} color={colors.chipSky} />
        <Text style={styles.attendeePillText} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="chevron-forward" size={12} color={colors.chipSky} />
      </Pressable>
    )
  }
  // Name-only attendee: no contactId → no nav target, but still long-press
  // to remove. Pressable wrapper just for the long-press handler.
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.attendeePill,
        styles.attendeePillDim,
        pressed && onLongPress ? styles.pressed : null,
      ]}
      accessibilityLabel={onLongPress ? `${label} (long-press to remove)` : label}
    >
      <Text style={styles.attendeePillText} numberOfLines={1}>
        {label}
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
            <RichMarkdown>{display.markdown}</RichMarkdown>
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

async function openExternal(url: string, label: string, fallback: string) {
  try {
    await Linking.openURL(url)
  } catch {
    Alert.alert(label, fallback)
  }
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
  flex: { flex: 1 },
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
  heroLogo: {
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
  linkChipDisabled: { opacity: 0.5 },
  linkChipTextDisabled: { color: colors.text4 },

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
  // Live-recording banner on the meeting view.
  recBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.crimsonMuted,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.crimson,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.crimson,
  },
  recLabel: {
    color: colors.crimson,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  recTimer: {
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  recStopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.crimson,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  recStopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' },
  recStopText: { color: '#fff', fontSize: type.bodyTight, fontWeight: '700' },
  recCancelLink: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  recCancelText: { color: colors.text3, fontSize: type.caption, fontWeight: '600' },
  offlineTagHint: {
    color: colors.text3,
    fontSize: type.caption,
    fontStyle: 'italic',
    marginBottom: spacing.md,
    marginTop: -spacing.xs,
  },
  // T17b — Record + Chat share one action band per detail screen so they
  // sit side-by-side when both apply (rare — Record is scheduled-only,
  // Chat needs content). Each item gets flex:1 for equal-width split.
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  actionsRowItem: { flex: 1 },
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
  // Chat CTA — outline crimson rather than solid, so when Record + Chat
  // are both visible the primary action (Record) reads as primary.
  chatCtaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.crimson,
  },
  chatCtaText: {
    color: colors.crimson,
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
  descRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  addBtn: {
    width: 28,
    height: 28,
    borderRadius: radii.md,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  descEmpty: {
    color: colors.text4,
    fontSize: type.meta,
    fontStyle: 'italic',
    marginTop: 4,
  },
  pillHint: {
    color: colors.text4,
    fontSize: type.meta - 1,
    fontStyle: 'italic',
    marginTop: 8,
  },
  descText: {
    color: colors.text2,
    fontSize: type.body + 1,
    lineHeight: 21,
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
  attendeePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.chipSkyMuted,
    borderRadius: radii.pill,
  },
  attendeePillDim: {
    opacity: 0.6,
  },
  attendeePillText: {
    color: colors.chipSky,
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

