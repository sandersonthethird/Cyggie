import { Alert } from 'react-native'
import { useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type ChatContextKind,
  createOrGetChatSession,
  fetchChatSession,
  fetchChatSessions,
  updateChatSession,
} from '../../lib/api/chat'
import { ChatComposer, type ChatComposerHandle } from '../../components/ChatComposer'
import { ChatSessionRow } from '../../components/ChatSessionRow'
import { CompanyMultiSelectSheet } from '../../components/CompanyMultiSelectSheet'
import { SelectedCompaniesPillRow } from '../../components/SelectedCompaniesPillRow'
import { useStartNewChat } from '../../components/useStartNewChat'
import { ScreenHeader, HeaderIconButton } from '../../components/ScreenHeader'
import { colors, radii, spacing, type } from '../../theme'

// T17b Slice 2 — Chat tab is the global ('crm') chat surface. The composer
// lives in <ChatComposer />; this screen owns the tab-nav appbar + the
// past-chats sheet that lets the user jump back to prior threads on any
// context kind.

const CRM_CONTEXT_KIND: ChatContextKind = 'crm'
const CRM_CONTEXT_ID = 'crm:global'
const CRM_CONTEXT_LABEL = 'Ask Cyggie'

export default function ChatTab(): React.JSX.Element {
  const [pastChatsOpen, setPastChatsOpen] = useState(false)
  const composerRef = useRef<ChatComposerHandle | null>(null)

  // Shares cache with ChatComposer via identical query key — TanStack
  // dedupes the request. Used here for messageCount + sessionId so the
  // New Chat pencil knows when to no-op / disable.
  const sessionQuery = useQuery({
    queryKey: ['chat', 'session-by-context', CRM_CONTEXT_KIND, CRM_CONTEXT_ID],
    queryFn: () =>
      createOrGetChatSession({
        contextKind: CRM_CONTEXT_KIND,
        contextId: CRM_CONTEXT_ID,
        contextLabel: CRM_CONTEXT_LABEL,
      }),
    staleTime: 60_000,
  })

  const messageCount = sessionQuery.data?.messageCount ?? 0
  const startNew = useStartNewChat({
    sessionId: sessionQuery.data?.id,
    contextKind: CRM_CONTEXT_KIND,
    contextId: CRM_CONTEXT_ID,
    messageCount,
    abortInflight: () => composerRef.current?.abortInflight(),
  })

  const newChatDisabled =
    sessionQuery.isLoading || startNew.isPending || messageCount === 0

  // Phase 2: hydrated chips for the pill row come from session detail
  // (gateway joins org_companies on the row's selectedCompanyIds + filters
  // stale IDs). Shares cache with ChatComposer's identical detailQuery
  // key (TanStack dedupes).
  const sessionId = sessionQuery.data?.id
  const detailQuery = useQuery({
    queryKey: ['chat', 'session-detail', sessionId],
    queryFn: ({ signal }) => fetchChatSession(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: 15_000,
  })

  const selectedCompanies = detailQuery.data?.selectedCompanies ?? []
  const existingIds = useMemo(
    () => selectedCompanies.map((c) => c.id),
    [selectedCompanies],
  )

  const qc = useQueryClient()
  const [pickerOpen, setPickerOpen] = useState(false)

  // PATCH that updates the selected_company_ids array. One mutation
  // backs both chip-remove (× on pill) and Done-tap-with-changes from the
  // picker. On 200, invalidate session-detail so the pill row rehydrates
  // (including the gateway's stale-ID filter pass).
  const updateMut = useMutation({
    mutationFn: async (nextIds: string[]) => {
      if (!sessionId) throw new Error('Session not ready')
      const result = await updateChatSession(sessionId, {
        selectedCompanyIds: nextIds,
      })
      if (!result.ok) {
        Alert.alert(
          'Could not update selection',
          'Someone else just changed this chat. Refresh and try again.',
        )
      }
      return result
    },
    onSuccess: (result) => {
      if (result.ok && sessionId) {
        qc.invalidateQueries({ queryKey: ['chat', 'session-detail', sessionId] })
        qc.invalidateQueries({
          queryKey: ['chat', 'session-by-context', CRM_CONTEXT_KIND, CRM_CONTEXT_ID],
        })
      }
    },
    onError: () => {
      Alert.alert(
        'Could not update selection',
        "Couldn't reach the server. Check your connection and try again.",
      )
    },
  })

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
      <ScreenHeader
        title="Ask Cyggie"
        subtitle="Global chat about your portfolio + pipeline"
        onBack={() => router.back()}
        showChatButton={false}
        borderBottom
        actions={
          <>
            <HeaderIconButton
              icon="create-outline"
              onPress={() => startNew.mutate()}
              accessibilityLabel="Start new chat"
              disabled={newChatDisabled}
            />
            <HeaderIconButton
              icon="time-outline"
              onPress={() => setPastChatsOpen(true)}
              accessibilityLabel="Past chats"
            />
          </>
        }
      />

      <SelectedCompaniesPillRow
        companies={selectedCompanies}
        onRemove={(id) =>
          updateMut.mutate(existingIds.filter((x) => x !== id))
        }
        onAdd={() => setPickerOpen(true)}
      />

      <ChatComposer
        ref={composerRef}
        contextKind={CRM_CONTEXT_KIND}
        contextId={CRM_CONTEXT_ID}
        contextLabel={CRM_CONTEXT_LABEL}
      />

      <CompanyMultiSelectSheet
        open={pickerOpen}
        initialSelectedIds={existingIds}
        onCommit={(ids) => {
          // Issue 2 fix from plan-eng-review: skip PATCH if user opened
          // the sheet but didn't change anything. Saves a lamport tick +
          // eliminates spurious 409s on no-change Done taps. Set compare
          // is order-independent (selection has no canonical order).
          const a = new Set(existingIds)
          const b = new Set(ids)
          const changed = a.size !== b.size || existingIds.some((id) => !b.has(id))
          if (changed) updateMut.mutate(ids)
          setPickerOpen(false)
        }}
        onClose={() => setPickerOpen(false)}
      />

      <PastChatsSheet open={pastChatsOpen} onClose={() => setPastChatsOpen(false)} />
    </SafeAreaView>
  )
}

// ─── Past-chats sheet ──────────────────────────────────────────────────────

// Exported for the resume-by-id navigation test (see
// __ui-tests__/PastChatsSheetResume.test.tsx). Otherwise private to ChatTab.
export function PastChatsSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const listQuery = useQuery({
    queryKey: ['chat', 'sessions-list', { includeArchived: false }],
    queryFn: ({ signal }) =>
      fetchChatSessions({ includeArchived: false, limit: 50 }, { signal }),
    enabled: open,
    staleTime: 30_000,
  })

  return (
    <Modal visible={open} animationType="fade" transparent onRequestClose={onClose}>
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.card}>
          <View style={sheetStyles.header}>
            <Text style={sheetStyles.title}>Past chats</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [sheetStyles.close, pressed && styles.pressed]}
              accessibilityLabel="Close past chats"
              accessibilityRole="button"
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={sheetStyles.list}>
            {listQuery.isLoading ? (
              <View style={sheetStyles.center}>
                <ActivityIndicator color={colors.crimson} />
              </View>
            ) : listQuery.error ? (
              <View style={sheetStyles.center}>
                <Text style={styles.errorText}>
                  {listQuery.error.message ?? 'Failed to load chats.'}
                </Text>
              </View>
            ) : (listQuery.data?.sessions ?? []).length === 0 ? (
              <View style={sheetStyles.center}>
                <Text style={sheetStyles.emptyText}>No chats yet.</Text>
              </View>
            ) : (
              (listQuery.data?.sessions ?? []).map((s) => (
                <ChatSessionRow
                  key={s.id}
                  session={s}
                  onPress={() => {
                    onClose()
                    // Special-case the global crm chat — it's the current
                    // tab; don't push a duplicate copy on top of itself.
                    if (s.contextKind === 'crm' && s.contextId === CRM_CONTEXT_ID) return
                    const kind = (s.contextKind || 'crm') as ChatContextKind
                    // Resume THIS exact session by id. Without sessionId the
                    // target screen find-or-creates the context's *active*
                    // session, so tapping an archived row would silently open
                    // a different chat than the one shown.
                    router.push({
                      pathname: '/chat/[contextKind]/[contextId]',
                      params: {
                        contextKind: kind,
                        contextId: s.contextId,
                        sessionId: s.id,
                        label: s.title ?? s.contextLabel ?? 'Chat',
                      },
                    })
                  }}
                />
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.6 },
  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
})

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    maxHeight: '80%',
    paddingBottom: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, color: colors.text, fontSize: type.h2, fontWeight: '700' },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  list: { paddingVertical: spacing.sm },
  center: { padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
})
