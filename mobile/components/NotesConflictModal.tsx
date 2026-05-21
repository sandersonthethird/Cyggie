import { useMemo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { diffNotes, type DiffSegment } from '../lib/meetings/diff-notes'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// NotesConflictModal — surfaced when the sync agent observes a 409 on
// PATCH /meetings/:id (another device wrote first with a higher lamport).
//
// 3-way choice:
//   • Replace — overwrite the server's value with yours.
//   • Keep yours — keep yours locally, do nothing to server (the server
//     winner stays; user can re-enqueue with a fresh lamport next keystroke).
//   • Discard both — take the server value verbatim, drop yours.
//
// "Both" sides are rendered side-by-side with a word-level diff
// highlighting additions (green) and removals (red strikethrough). See
// `diffNotes` for the wrapping over the `diff` npm package.
// =============================================================================

export interface ConflictPayload {
  meetingId: string
  yours: string | null
  theirs: string | null
}

interface Props {
  payload: ConflictPayload | null
  onReplaceTheirs: (yours: string | null) => void
  onKeepYours: () => void
  onDiscardBoth: (theirs: string | null) => void
  onDismiss: () => void
}

export function NotesConflictModal({
  payload,
  onReplaceTheirs,
  onKeepYours,
  onDiscardBoth,
  onDismiss,
}: Props) {
  const open = payload !== null
  const yoursSegments = useMemo(
    () => (payload ? diffNotes(payload.theirs, payload.yours) : []),
    [payload],
  )
  const theirsSegments = useMemo(
    () => (payload ? diffNotes(payload.yours, payload.theirs) : []),
    [payload],
  )
  return (
    <Modal
      visible={open}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="alert-circle" size={20} color={colors.crimson} />
            <Text style={styles.headerTitle}>Notes conflict</Text>
          </View>
          <Text style={styles.subtitle}>
            Another device edited these notes since you started. Choose how to
            resolve.
          </Text>

          <ScrollView style={styles.diffScroll} contentContainerStyle={styles.diffWrap}>
            <DiffPane label="Yours" segments={yoursSegments} showOnly="kept-and-added" />
            <View style={styles.diffDivider} />
            <DiffPane label="Theirs" segments={theirsSegments} showOnly="kept-and-added" />
          </ScrollView>

          <View style={styles.actions}>
            <ActionBtn
              label="Replace theirs"
              kind="primary"
              onPress={() => payload && onReplaceTheirs(payload.yours)}
            />
            <ActionBtn
              label="Keep yours"
              kind="secondary"
              onPress={onKeepYours}
            />
            <ActionBtn
              label="Discard both, take theirs"
              kind="tertiary"
              onPress={() => payload && onDiscardBoth(payload.theirs)}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

function DiffPane({
  label,
  segments,
  showOnly,
}: {
  label: string
  segments: DiffSegment[]
  showOnly: 'kept-and-added'
}) {
  // From `yours`-vs-theirs diff, the `added` segments are what's only in
  // `yours`. `removed` is what's only in `theirs`. For the "Yours" pane we
  // want unchanged + added (the prose the user wrote). For the "Theirs" pane
  // the diff was inverted, so the same render rule applies.
  return (
    <View style={styles.diffPane}>
      <Text style={styles.diffLabel}>{label}</Text>
      <Text style={styles.diffBody}>
        {segments
          .filter((s) => showOnly === 'kept-and-added' && s.kind !== 'removed')
          .map((s, i) => (
            <Text
              key={i}
              style={[
                s.kind === 'added' && styles.diffAdded,
                s.kind === 'unchanged' && styles.diffUnchanged,
              ]}
            >
              {s.text}
            </Text>
          ))}
      </Text>
    </View>
  )
}

function ActionBtn({
  label,
  kind,
  onPress,
}: {
  label: string
  kind: 'primary' | 'secondary' | 'tertiary'
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        kind === 'primary' && styles.btnPrimary,
        kind === 'secondary' && styles.btnSecondary,
        kind === 'tertiary' && styles.btnTertiary,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.btnText,
          kind === 'primary' && styles.btnTextPrimary,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.lg,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  headerTitle: {
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginBottom: spacing.md,
  },
  diffScroll: {
    maxHeight: 300,
    marginBottom: spacing.md,
  },
  diffWrap: {
    gap: spacing.sm,
  },
  diffPane: {
    backgroundColor: colors.surface3,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: 80,
  },
  diffDivider: { height: spacing.sm },
  diffLabel: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  diffBody: {
    color: colors.text2,
    fontSize: type.body,
    lineHeight: 20,
  },
  diffAdded: {
    backgroundColor: '#DCFCE7', // light green
    color: colors.success,
  },
  diffUnchanged: {
    color: colors.text2,
  },
  actions: {
    gap: 8,
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: colors.crimson,
  },
  btnSecondary: {
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnTertiary: {
    backgroundColor: 'transparent',
  },
  btnText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  btnTextPrimary: {
    color: '#FFFFFF',
  },
  pressed: { opacity: 0.7 },
})
