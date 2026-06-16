import { useEffect, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { KeyboardAvoidingScreen } from './KeyboardAvoidingScreen'
import { Ionicons } from '@expo/vector-icons'

import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// EntityPicker — generic typeahead modal used by ContactPicker + CompanyPicker.
//
// Mirrors the desktop renderer/components/common/EntityPicker.tsx pattern:
//   1. User types → debounced search via `onSearch`
//   2. Results render; tap an item → `onPick(item)`
//   3. When `allowCreate` + the typed query doesn't match an existing
//      result, render a "Create '{query}'" row → `onCreate(query)`
//
// Modeless callers control open/close. Picker doesn't own any data
// caching; callers pass `onSearch` returning fresh results per query.
// =============================================================================

export interface EntityPickerProps<T> {
  open: boolean
  onClose: () => void
  title: string
  placeholder: string
  /** Called on every (debounced) query change. Returns matching items. */
  onSearch: (query: string, signal: AbortSignal) => Promise<T[]>
  /** Renders one row given an item. Caller controls layout/labels. */
  renderItem: (item: T) => ReactNode
  /** Stable key per item (id). */
  keyFor: (item: T) => string
  /** Called when the user taps an existing-item row. */
  onPick: (item: T) => void
  /** Optional create-on-the-fly affordance — called with the trimmed
   *  query when the user taps "Create '{query}'". Caller is responsible
   *  for the actual create + (typically) calling onPick on the result. */
  onCreate?: (query: string) => void
  /** Label shown on the create row. Defaults to `Create "{query}"`. */
  createLabel?: (query: string) => string
}

export function EntityPicker<T>({
  open,
  onClose,
  title,
  placeholder,
  onSearch,
  renderItem,
  keyFor,
  onPick,
  onCreate,
  createLabel,
}: EntityPickerProps<T>): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounced search. Re-runs 250ms after the user stops typing, OR
  // immediately when the modal opens (so the empty-query case loads
  // the user's most-recent contacts/companies).
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const results = await onSearch(query.trim(), controller.signal)
        if (!controller.signal.aborted) setItems(results)
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Search failed')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, query, onSearch])

  // Reset query when the modal closes so reopening starts fresh.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const trimmed = query.trim()
  const showCreate =
    Boolean(onCreate) &&
    trimmed.length > 0 &&
    !loading &&
    // Only show "Create" when no item's display matches the query exactly.
    // We can't tell what the renderer is going to display, so the heuristic
    // is conservative: show Create whenever we have any non-empty query.
    // Callers can suppress by passing onCreate={undefined}.
    true

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
        <KeyboardAvoidingScreen style={styles.flex}>
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
              accessibilityLabel="Cancel"
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.closeBtn} />
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={18} color={colors.text3} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={placeholder}
              placeholderTextColor={colors.text4}
              style={styles.searchInput}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={8}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                accessibilityLabel="Clear search"
                accessibilityRole="button"
              >
                <Ionicons name="close-circle" size={18} color={colors.text4} />
              </Pressable>
            )}
          </View>

          <ScrollView
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
          >
            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator color={colors.crimson} />
              </View>
            ) : error ? (
              <View style={styles.center}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : items.length === 0 && !showCreate ? (
              <View style={styles.center}>
                <Text style={styles.emptyText}>
                  {trimmed
                    ? `No matches for "${trimmed}".`
                    : 'Start typing to search.'}
                </Text>
              </View>
            ) : (
              <>
                {items.map((item) => (
                  <Pressable
                    key={keyFor(item)}
                    onPress={() => onPick(item)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && { backgroundColor: colors.surface3 },
                    ]}
                    accessibilityRole="button"
                  >
                    {renderItem(item)}
                  </Pressable>
                ))}
                {showCreate && (
                  <Pressable
                    onPress={() => onCreate!(trimmed)}
                    style={({ pressed }) => [
                      styles.row,
                      styles.createRow,
                      pressed && { backgroundColor: colors.surface3 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Create new entry: ${trimmed}`}
                  >
                    <View style={styles.createIcon}>
                      <Ionicons name="add" size={20} color={colors.crimson} />
                    </View>
                    <Text style={styles.createText}>
                      {createLabel ? createLabel(trimmed) : `Create "${trimmed}"`}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingScreen>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  closeBtn: { minWidth: 60, alignItems: 'flex-start' },
  cancelText: { color: colors.crimson, fontSize: type.body, fontWeight: '500' },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: type.body, fontWeight: '600' },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface3,
    borderRadius: radii.lg,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    color: colors.text,
    fontSize: type.body + 1,
  },

  list: { paddingVertical: spacing.sm, flexGrow: 1 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  createRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
  },
  createIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.md,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createText: { color: colors.crimson, fontSize: type.body + 1, fontWeight: '600' },

  center: { padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
  emptyText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
})
