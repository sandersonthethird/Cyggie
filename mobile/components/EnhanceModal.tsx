import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { SummaryTemplate } from '../lib/api/meetings'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// EnhanceModal — template picker for POST /meetings/:id/enhance.
//
// Pattern mirrors NotesConflictModal: native Modal with animationType
// 'fade' + transparent overlay + centered card. Lists templates as
// pressable rows (name + description). On tap → onSelect(template.id) →
// parent closes the modal and kicks off the enhance call.
//
// Loading state for the template list lives in the parent (TanStack
// query); this component only renders once data is present. If templates
// is empty, the modal shows an "unavailable" empty state.
// =============================================================================

interface Props {
  open: boolean
  templates: SummaryTemplate[]
  isLoading: boolean
  hasExistingSummary: boolean
  onSelect: (templateId: string) => void
  onDismiss: () => void
}

export function EnhanceModal({
  open,
  templates,
  isLoading,
  hasExistingSummary,
  onSelect,
  onDismiss,
}: Props): React.JSX.Element {
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
            <Ionicons name="sparkles" size={20} color={colors.crimson} />
            <Text style={styles.headerTitle}>
              {hasExistingSummary ? 'Re-enhance summary' : 'Enhance summary'}
            </Text>
          </View>
          <Text style={styles.subtitle}>
            {hasExistingSummary
              ? 'Pick a template to generate a fresh summary. The current one will be overwritten.'
              : 'Pick a template to summarize the meeting transcript with Cyggie.'}
          </Text>

          {isLoading ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>Loading templates…</Text>
            </View>
          ) : templates.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                No templates available. Try again later or open this meeting on
                desktop.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listWrap}>
              {templates.map((t) => (
                <Pressable
                  key={t.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${t.name} template`}
                  onPress={() => onSelect(t.id)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <Text style={styles.rowTitle}>{t.name}</Text>
                  <Text style={styles.rowDesc} numberOfLines={2}>
                    {t.description}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onDismiss}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
  list: {
    maxHeight: 380,
  },
  listWrap: {
    gap: spacing.sm,
  },
  row: {
    backgroundColor: colors.surface3,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.crimsonMuted,
  },
  rowTitle: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowDesc: {
    color: colors.text3,
    fontSize: type.meta,
    lineHeight: 16,
  },
  emptyState: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
  },
  cancelBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnPressed: {
    backgroundColor: colors.surface3,
  },
  cancelText: {
    color: colors.text2,
    fontSize: type.body,
    fontWeight: '600',
  },
})
