import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// UserNoteEditor — mobile-side click-to-edit textarea for the user-authored
// portion of Key Takeaways. Used by both contact and company detail screens
// (full-parity choice from /plan-eng-review).
//
//   Idle, empty value:
//     • + Add note…              ← tappable
//
//   Idle, populated value:
//     • line 1                   ← tappable
//     • line 2
//
//   Editing:
//     ┌────────────────────────┐
//     │ multiline TextInput    │
//     └────────────────────────┘
//                  [Cancel] [Save]
//
// 2000-char cap enforced client-side (server also caps). On save failure,
// re-enters edit state with the unsaved text retained so a flaky network
// doesn't lose keystrokes.
// =============================================================================

const MAX_CHARS = 2000
const PLACEHOLDER = '+ Add note…'

interface Props {
  /** Current saved value from the server. `null` renders the placeholder. */
  value: string | null
  /** Persist the new value (or null to clear). Resolve = success, reject = error. */
  onSave: (next: string | null) => Promise<void>
}

export function UserNoteEditor({ value, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(value ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<TextInput>(null)

  // Re-sync local draft when the server value changes between renders
  // (e.g. parent refetch after navigation).
  useEffect(() => {
    if (!editing) {
      setDraft(value ?? '')
      setError(null)
    }
  }, [value, editing])

  const bullets = useMemo(() => {
    if (!value) return []
    return value
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean)
  }, [value])

  const startEditing = (): void => {
    setError(null)
    setEditing(true)
    setDraft(value ?? '')
    // Defer so the TextInput mounts before focus is requested.
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const cancelEditing = (): void => {
    setEditing(false)
    setDraft(value ?? '')
    setError(null)
  }

  const handleSave = async (): Promise<void> => {
    const trimmed = draft.trim()
    const capped = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed
    const next = capped || null

    setSaving(true)
    setError(null)
    try {
      await onSave(next)
      setEditing(false)
      setDraft(capped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed — please try again')
      // Stay in edit mode so the user doesn't lose their text.
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <View style={styles.container}>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={MAX_CHARS}
          placeholder="Your note — each new line becomes a bullet."
          placeholderTextColor={colors.text4}
          style={styles.textInput}
          editable={!saving}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.actions}>
          <Pressable
            onPress={cancelEditing}
            disabled={saving}
            style={({ pressed }) => [
              styles.cancelBtn,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={({ pressed }) => [
              styles.saveBtn,
              (pressed || saving) && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // Idle render: bullets (or empty-state placeholder), tappable to enter edit.
  return (
    <Pressable
      onPress={startEditing}
      accessibilityRole="button"
      accessibilityLabel={value ? 'Edit your note' : 'Add a note'}
      style={({ pressed }) => [
        styles.container,
        pressed && { opacity: 0.7 },
      ]}
    >
      {bullets.length === 0 ? (
        <View style={styles.bulletRow}>
          <View style={[styles.bulletDot, styles.bulletDotMuted]} />
          <Text style={styles.placeholderText}>{PLACEHOLDER}</Text>
        </View>
      ) : (
        bullets.map((line, i) => (
          <View key={i} style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 2,
  },
  bulletDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.crimson,
    marginTop: 8,
  },
  bulletDotMuted: {
    opacity: 0.4,
  },
  bulletText: {
    fontSize: type.body,
    color: colors.text,
    flex: 1,
  },
  placeholderText: {
    fontSize: type.body,
    color: colors.text3,
    fontStyle: 'italic',
    flex: 1,
  },
  textInput: {
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.sm,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: {
    fontSize: type.body,
    color: colors.text3,
  },
  saveBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    backgroundColor: colors.crimson,
  },
  saveBtnText: {
    fontSize: type.body,
    color: colors.surface,
    fontWeight: '600',
  },
  error: {
    fontSize: type.body,
    color: colors.rec,
    marginTop: spacing.xs,
  },
})
