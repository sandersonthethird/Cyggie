import { Ionicons } from '@expo/vector-icons'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CompanyChip } from '../lib/api/chat'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// SelectedCompaniesPillRow — pure presentation. Renders a horizontal row
// of chips for the companies whose context is being injected into the
// global Ask Cyggie chat's LLM system prompt. Owned by the Ask Cyggie tab
// (mobile/app/(tabs)/chat.tsx); fed hydrated CompanyChip[] from the
// session-detail query.
//
// Each chip shows the company name + an inline × button that removes the
// chip via onRemove(id). A trailing "+" chip opens the picker via onAdd().
//
// Empty case (no companies selected): renders just the "+" chip with the
// hint copy "Add company context" so the user knows the affordance exists.
// =============================================================================

export interface SelectedCompaniesPillRowProps {
  companies: CompanyChip[]
  onRemove: (companyId: string) => void
  onAdd: () => void
  /** When true, hide chip remove buttons + disable the "+". Used for
   *  archived/read-only sessions. */
  disabled?: boolean
}

export function SelectedCompaniesPillRow({
  companies,
  onRemove,
  onAdd,
  disabled = false,
}: SelectedCompaniesPillRowProps): React.JSX.Element {
  const isEmpty = companies.length === 0
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {companies.map((c) => (
          <View key={c.id} style={styles.chip}>
            <Text style={styles.chipText} numberOfLines={1}>
              {c.name}
            </Text>
            {!disabled && (
              <Pressable
                onPress={() => onRemove(c.id)}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.removeBtn,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${c.name}`}
              >
                <Ionicons name="close" size={14} color={colors.text3} />
              </Pressable>
            )}
          </View>
        ))}
        <Pressable
          onPress={onAdd}
          disabled={disabled}
          hitSlop={4}
          style={({ pressed }) => [
            styles.addChip,
            disabled && styles.addChipDisabled,
            pressed && !disabled && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={
            isEmpty ? 'Add company context' : 'Add another company'
          }
          accessibilityState={{ disabled }}
        >
          <Ionicons name="add" size={16} color={colors.text2} />
          {isEmpty ? (
            <Text style={styles.addText}>Add company context</Text>
          ) : null}
        </Pressable>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  scroll: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.md,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 220,
  },
  chipText: {
    color: colors.text,
    fontSize: type.meta,
    fontWeight: '600',
  },
  removeBtn: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
  addChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  addChipDisabled: { opacity: 0.4 },
  addText: { color: colors.text2, fontSize: type.meta, fontWeight: '600' },
  pressed: { opacity: 0.6 },
})
