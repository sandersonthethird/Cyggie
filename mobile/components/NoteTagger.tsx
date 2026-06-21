import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { CompanyPicker } from './CompanyPicker'
import { ContactPicker } from './ContactPicker'
import { colors, radii, spacing, type } from '../theme'

// Note entity-tagging affordance — mirrors the desktop NoteTagger:
//   • tagged  → a crimson chip with the entity name + an × to clear
//   • untagged → a "+ Company" / "+ Contact" button that opens the picker
//
// Tagging a note to a company/contact is what makes a non-private note
// firm-visible (see the gateway noteVisibilityFilter). The pickers hand back
// both id and name, so the chip label is server-truth without an extra fetch.

export interface NoteTaggerProps {
  companyId: string | null
  companyName: string | null
  contactId: string | null
  contactName: string | null
  onTagCompany: (id: string | null, name: string | null) => void
  onTagContact: (id: string | null, name: string | null) => void
  disabled?: boolean
}

export function NoteTagger({
  companyId,
  companyName,
  contactId,
  contactName,
  onTagCompany,
  onTagContact,
  disabled,
}: NoteTaggerProps): React.JSX.Element {
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false)
  const [contactPickerOpen, setContactPickerOpen] = useState(false)

  return (
    <View style={styles.root}>
      <TagSlot
        icon="business-outline"
        addLabel="Company"
        id={companyId}
        name={companyName}
        disabled={disabled}
        onAdd={() => setCompanyPickerOpen(true)}
        onClear={() => onTagCompany(null, null)}
      />
      <TagSlot
        icon="person-outline"
        addLabel="Contact"
        id={contactId}
        name={contactName}
        disabled={disabled}
        onAdd={() => setContactPickerOpen(true)}
        onClear={() => onTagContact(null, null)}
      />

      <CompanyPicker
        open={companyPickerOpen}
        onClose={() => setCompanyPickerOpen(false)}
        onPick={(company) => {
          onTagCompany(company.id, company.name)
          setCompanyPickerOpen(false)
        }}
      />
      <ContactPicker
        open={contactPickerOpen}
        onClose={() => setContactPickerOpen(false)}
        onPick={(contact) => {
          onTagContact(contact.id, contact.fullName)
          setContactPickerOpen(false)
        }}
      />
    </View>
  )
}

function TagSlot({
  icon,
  addLabel,
  id,
  name,
  disabled,
  onAdd,
  onClear,
}: {
  icon: keyof typeof Ionicons.glyphMap
  addLabel: string
  id: string | null
  name: string | null
  disabled?: boolean
  onAdd: () => void
  onClear: () => void
}): React.JSX.Element {
  if (id) {
    return (
      <View style={styles.chip}>
        <Ionicons name={icon} size={13} color={colors.crimson} />
        <Text style={styles.chipText} numberOfLines={1}>
          {name ?? 'Tagged'}
        </Text>
        <Pressable
          onPress={onClear}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${addLabel.toLowerCase()} tag`}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Ionicons name="close-circle" size={16} color={colors.crimson} />
        </Pressable>
      </View>
    )
  }
  return (
    <Pressable
      onPress={onAdd}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Tag ${addLabel.toLowerCase()}`}
      style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
    >
      <Ionicons name="add" size={15} color={colors.text3} />
      <Text style={styles.addText}>{addLabel}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  chipText: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '600',
    maxWidth: 180,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.surface3,
    borderRadius: radii.pill,
  },
  addText: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  pressed: { opacity: 0.6 },
})
