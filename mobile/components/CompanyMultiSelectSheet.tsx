import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'

import { type CompanyListItem, fetchCompanies } from '../lib/api/companies'
import { CompanyLogo } from './CompanyLogo'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// CompanyMultiSelectSheet — multi-select modal for Phase 2's Ask Cyggie
// company-context picker.
//
// Interaction model differs from EntityPicker (single-select tap-to-pick):
//   - user opens sheet with `initialSelectedIds`
//   - searches via debounced fetchCompanies(q)
//   - taps any row to TOGGLE that company in/out of an in-progress local set
//   - taps Done → onCommit(string[]) with the final array
//   - taps Cancel / backdrop → onClose without commit
//
// Selected rows show a checkmark; the trailing "Done" button shows a count
// badge.
//
// NOT extending EntityPicker because the toggle-vs-immediate-pick + Done
// commit barrier are fundamentally different UX shapes. Sharing a
// SearchableList primitive could come later if a third surface needs it.
// =============================================================================

export interface CompanyMultiSelectSheetProps {
  open: boolean
  initialSelectedIds: string[]
  onCommit: (ids: string[]) => void
  onClose: () => void
}

export function CompanyMultiSelectSheet({
  open,
  initialSelectedIds,
  onCommit,
  onClose,
}: CompanyMultiSelectSheetProps): React.JSX.Element {
  // useSafeAreaInsets (not the SafeAreaView wrapper) because transparent
  // Modals on iOS don't reliably propagate the safe-area inset context
  // to <SafeAreaView>; the result is a header that renders under the
  // notch/status bar and silently swallows taps (touches don't reach
  // pixels under the system UI). Reading insets directly and applying
  // them as explicit paddingTop sidesteps both symptoms.
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CompanyListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // In-progress selection — committed only on Done. Re-seeded from
  // initialSelectedIds every time the sheet opens so subsequent re-opens
  // reflect any external changes (e.g. another device archived a session).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialSelectedIds),
  )
  // We need to ALSO remember selected companies that aren't in the current
  // search results — otherwise toggling off a chip that's "off-screen"
  // would silently re-toggle it back on (no row → no UI to manage state).
  // Cache hydrated companies as user toggles them so they survive search
  // filtering.
  const [hydratedCache, setHydratedCache] = useState<Map<string, CompanyListItem>>(
    () => new Map(),
  )

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(initialSelectedIds))
      setQuery('')
    }
  }, [open, initialSelectedIds])

  // Debounced search. Empty query loads recent companies (server default).
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const results = await fetchCompanies(
          { q: query.trim() || undefined, limit: 50, signal: controller.signal },
        )
        if (!controller.signal.aborted) {
          setItems(results.companies)
          // Backfill hydrated cache with anything in results (used so the
          // "selected but not in current results" companies still render).
          setHydratedCache((prev) => {
            const next = new Map(prev)
            for (const c of results.companies) next.set(c.id, c)
            return next
          })
        }
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
  }, [open, query])

  const toggle = (company: CompanyListItem): void => {
    setHydratedCache((prev) => {
      if (prev.has(company.id)) return prev
      const next = new Map(prev)
      next.set(company.id, company)
      return next
    })
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(company.id)) next.delete(company.id)
      else next.add(company.id)
      return next
    })
  }

  const handleDone = (): void => {
    onCommit(Array.from(selectedIds))
  }

  // Selected rows pinned to top (so the user sees what they've picked even
  // when searching a different word). De-dupe against current search items.
  const selectedItems: CompanyListItem[] = Array.from(selectedIds)
    .map((id) => hydratedCache.get(id))
    .filter((c): c is CompanyListItem => c !== undefined)
  const selectedIdSet = selectedIds
  const remainingItems = items.filter((c) => !selectedIdSet.has(c.id))

  const trimmed = query.trim()
  const count = selectedIds.size

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
              accessibilityLabel="Cancel"
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              Add companies
            </Text>
            <Pressable
              onPress={handleDone}
              hitSlop={8}
              style={({ pressed }) => [
                styles.headerBtn,
                styles.headerBtnRight,
                pressed && styles.pressed,
              ]}
              accessibilityLabel={`Done — ${count} companies selected`}
              accessibilityRole="button"
            >
              <Text style={styles.doneText}>
                Done{count > 0 ? ` (${count})` : ''}
              </Text>
            </Pressable>
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={18} color={colors.text3} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search companies"
              placeholderTextColor={colors.text4}
              style={styles.searchInput}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={8}
                style={({ pressed }) => [pressed && styles.pressed]}
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
            {loading && items.length === 0 ? (
              <View style={styles.center}>
                <ActivityIndicator color={colors.crimson} />
              </View>
            ) : error ? (
              <View style={styles.center}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : (
              <>
                {selectedItems.length > 0 && (
                  <View>
                    <Text style={styles.sectionHeader}>Selected</Text>
                    {selectedItems.map((c) => (
                      <CompanyRow
                        key={`sel-${c.id}`}
                        company={c}
                        selected
                        onPress={() => toggle(c)}
                      />
                    ))}
                  </View>
                )}
                {remainingItems.length > 0 && (
                  <View>
                    {selectedItems.length > 0 && (
                      <Text style={styles.sectionHeader}>
                        {trimmed ? 'Matches' : 'All companies'}
                      </Text>
                    )}
                    {remainingItems.map((c) => (
                      <CompanyRow
                        key={c.id}
                        company={c}
                        selected={false}
                        onPress={() => toggle(c)}
                      />
                    ))}
                  </View>
                )}
                {selectedItems.length === 0 && remainingItems.length === 0 && (
                  <View style={styles.center}>
                    <Text style={styles.emptyText}>
                      {trimmed
                        ? `No matches for "${trimmed}".`
                        : 'No companies yet.'}
                    </Text>
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

function CompanyRow({
  company,
  selected,
  onPress,
}: {
  company: CompanyListItem
  selected: boolean
  onPress: () => void
}): React.JSX.Element {
  const sub = [company.industry, company.stage].filter(Boolean).join(' · ')
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.surface3 },
      ]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${company.name}${sub ? `, ${sub}` : ''}`}
    >
      <View style={[styles.checkbox, selected && styles.checkboxOn]}>
        {selected && <Ionicons name="checkmark" size={14} color={colors.surface} />}
      </View>
      <CompanyLogo
        domain={company.primaryDomain}
        name={company.name}
        size={28}
        shape="rounded"
        style={styles.rowLogo}
      />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {company.name}
        </Text>
        {sub && (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {sub}
          </Text>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  // Explicit padding on the buttons themselves gives a comfortable
  // 44pt-ish tap target (iOS HIG minimum), independent of the header's
  // own padding. Helps guard against any inset miscalculation.
  headerBtn: {
    minWidth: 60,
    paddingVertical: spacing.xs,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  headerBtnRight: { alignItems: 'flex-end' },
  cancelText: { color: colors.text2, fontSize: type.body, fontWeight: '500' },
  doneText: { color: colors.crimson, fontSize: type.body, fontWeight: '600' },
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
  sectionHeader: {
    color: colors.text3,
    fontSize: type.meta,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    letterSpacing: 0.5,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxOn: {
    backgroundColor: colors.crimson,
    borderColor: colors.crimson,
  },
  rowLogo: { marginRight: spacing.sm },
  rowText: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: type.body + 1, fontWeight: '600' },
  rowMeta: { color: colors.text3, fontSize: type.meta, marginTop: 2 },

  center: { padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
  emptyText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
  pressed: { opacity: 0.6 },
})
