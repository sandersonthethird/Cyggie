import { useCallback } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import {
  type ContactListItem,
  createContact,
  fetchContacts,
} from '../lib/api/contacts'
import { EntityPicker } from './EntityPicker'
import { colors, radii, spacing, type } from '../theme'

// Contact-typed wrapper around EntityPicker. Used by meeting detail's
// "Add Attendee" affordance.
//
// "Create '{query}'" is enabled — calls POST /contacts with just
// `{fullName: query}` (no enrichment, mirrors desktop's MeetingDetail
// CONTACT_CREATE → addAttendee flow).

export interface ContactPickerProps {
  open: boolean
  onClose: () => void
  /** Called with the picked (or freshly-created) contact. The screen
   *  then appends to meeting.attendees + attendeeEmails and PATCHes the
   *  gateway. */
  onPick: (contact: ContactListItem) => void
}

export function ContactPicker({
  open,
  onClose,
  onPick,
}: ContactPickerProps): React.JSX.Element {
  const onSearch = useCallback(
    async (query: string, signal: AbortSignal): Promise<ContactListItem[]> => {
      const opts: { limit: number; signal: AbortSignal; q?: string } = {
        limit: 30,
        signal,
      }
      if (query) opts.q = query
      const res = await fetchContacts(opts)
      return res.contacts
    },
    [],
  )

  const onCreate = useCallback(
    async (query: string) => {
      // Bare create — no email. Desktop's pattern: free-text name → new
      // Contact row → append to attendees array. We do the create, then
      // hand the new contact to onPick so the caller treats it like a
      // normal selection.
      try {
        const { contact } = await createContact({ fullName: query })
        onPick(contact)
      } catch {
        // Surfaced via the picker's own error state on the next typed
        // character. The user can retry by re-clicking Create.
      }
    },
    [onPick],
  )

  return (
    <EntityPicker<ContactListItem>
      open={open}
      onClose={onClose}
      title="Add attendee"
      placeholder="Search contacts…"
      onSearch={onSearch}
      keyFor={(c) => c.id}
      renderItem={(c) => <ContactRow contact={c} />}
      onPick={onPick}
      onCreate={onCreate}
    />
  )
}

function ContactRow({ contact }: { contact: ContactListItem }): React.JSX.Element {
  const subtitle = [contact.title, contact.primaryCompanyName].filter(Boolean).join(' · ')
  return (
    <>
      <View style={styles.avatar}>
        <Ionicons name="person-outline" size={18} color={colors.text3} />
      </View>
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {contact.fullName}
        </Text>
        {(subtitle || contact.email) && (
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle || contact.email}
          </Text>
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  avatar: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1 },
  name: { color: colors.text, fontSize: type.body + 1, fontWeight: '500' },
  meta: { color: colors.text3, fontSize: type.meta, marginTop: 2 },
})
