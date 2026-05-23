import type { AttendeeContact } from './api/meetings'

export function attendeeLabel(a: AttendeeContact): string {
  if (a.contactFullName) return a.contactFullName
  if (a.name && a.name !== a.email) return a.name
  if (a.email) return a.email
  return 'Unknown'
}
