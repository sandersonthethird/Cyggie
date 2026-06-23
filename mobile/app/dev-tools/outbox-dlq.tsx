// =============================================================================
// dev-tools/outbox-dlq.tsx — view + replay the mobile outbox dead-letter queue.
//
// Entries land in the DLQ on a permanent gateway error (400/404) or after
// MAX_RETRIES. Until now there was no surface to see why a write failed or to
// retry it (Sentry captures the exception but not the entry contents). This
// screen lists each dead entry and lets a dev/support engineer Replay it (back
// into the active queue + immediate drain) or Dismiss it.
//
//   loadDLQ() ──▶ [entry cards] ──┬─ Replay ─▶ replayFromDLQ(id) ─▶ drainNow()
//                                 └─ Dismiss ─▶ removeFromDLQ(id)
//   header ───────────────────────── Clear all ─▶ clearDLQ()
// =============================================================================

import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Section } from '../../components/settings-rows'
import {
  loadDLQ,
  replayFromDLQ,
  removeFromDLQ,
  clearDLQ,
  type OutboxEntry,
} from '../../lib/sync/outbox'
import { drainNow } from '../../lib/sync/agent'
import { colors, radii, spacing, type } from '../../theme'

export default function OutboxDLQScreen(): React.JSX.Element {
  // MMKV is synchronous, so a plain useState seeded from loadDLQ() + re-read
  // after each mutation is all we need — no query layer.
  const [entries, setEntries] = useState<OutboxEntry[]>(() => loadDLQ())
  const refresh = useCallback(() => setEntries(loadDLQ()), [])

  const onReplay = useCallback(
    (id: string) => {
      replayFromDLQ(id)
      refresh()
      // Fire-and-forget — kick a drain so the user sees it leave immediately
      // when online. Offline, it stays in the active queue and drains later.
      void drainNow()
    },
    [refresh],
  )

  const onDismiss = useCallback(
    (id: string) => {
      removeFromDLQ(id)
      refresh()
    },
    [refresh],
  )

  const onClearAll = useCallback(() => {
    Alert.alert('Clear dead-letter queue?', 'This permanently discards all failed writes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear all',
        style: 'destructive',
        onPress: () => {
          clearDLQ()
          refresh()
        },
      },
    ])
  }, [refresh])

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle}>Dead-letter queue</Text>
          <Pressable
            onPress={onClearAll}
            disabled={entries.length === 0}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Clear all"
            accessibilityRole="button"
          >
            <Ionicons
              name="trash-outline"
              size={20}
              color={entries.length === 0 ? colors.text4 : colors.crimson}
            />
          </Pressable>
        </View>
      </SafeAreaView>
      <SafeAreaView edges={['bottom']} style={styles.bodyArea}>
        <ScrollView contentContainerStyle={styles.scroll}>
          {entries.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={40} color={colors.text4} />
              <Text style={styles.emptyText}>No dead-lettered writes.</Text>
            </View>
          ) : (
            <Section title={`${entries.length} failed write${entries.length === 1 ? '' : 's'}`}>
              {entries.map((entry) => (
                <DLQRow
                  key={entry.id}
                  entry={entry}
                  onReplay={() => onReplay(entry.id)}
                  onDismiss={() => onDismiss(entry.id)}
                />
              ))}
            </Section>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  )
}

interface DLQRowProps {
  entry: OutboxEntry
  onReplay: () => void
  onDismiss: () => void
}

function DLQRow({ entry, onReplay, onDismiss }: DLQRowProps): React.JSX.Element {
  return (
    <View style={styles.entryRow}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryOp}>{entry.op}</Text>
        <Text style={styles.entryMeta}>retries {entry.retries}</Text>
      </View>
      <Text style={styles.entryResource} numberOfLines={1}>
        {entry.resourceId}
      </Text>
      {entry.lastError ? (
        <Text style={styles.entryError} numberOfLines={3}>
          {entry.lastError}
        </Text>
      ) : null}
      <Text style={styles.entryDate}>{entry.createdAt}</Text>
      <View style={styles.entryActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Replay"
          onPress={onReplay}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
        >
          <Ionicons name="refresh" size={16} color={colors.text} />
          <Text style={styles.actionLabel}>Replay</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={16} color={colors.crimson} />
          <Text style={[styles.actionLabel, styles.actionLabelDestructive]}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },
  bodyArea: { flex: 1, backgroundColor: colors.bg },

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
  pressed: { backgroundColor: colors.surface3 },

  scroll: { padding: spacing.lg, gap: spacing.lg },

  empty: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xl * 2 },
  emptyText: { color: colors.text3, fontSize: type.body },

  entryRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryOp: { color: colors.text, fontSize: type.body, fontWeight: '600' },
  entryMeta: { color: colors.text3, fontSize: type.meta },
  entryResource: { color: colors.text2, fontSize: type.bodyTight, fontFamily: 'Menlo' },
  entryError: { color: colors.crimson, fontSize: type.bodyTight },
  entryDate: { color: colors.text4, fontSize: type.meta },
  entryActions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionLabel: { color: colors.text, fontSize: type.bodyTight, fontWeight: '600' },
  actionLabelDestructive: { color: colors.crimson },
})
