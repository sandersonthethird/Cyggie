import * as contactRepo from '../database/repositories/contact.repo'
import * as contactNotesRepo from '../database/repositories/contact-notes.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readSummary, readTranscript } from '../storage/file-manager'

const MAX_SUMMARY_CHARS = 6000
const MAX_TRANSCRIPT_CHARS = 2500
const MAX_EMAIL_BODY_CHARS = 1500
const MAX_NOTE_CHARS = 2000
const MAX_TOTAL_SUMMARIES = 24000
const MAX_TOTAL_EMAILS = 12000
const MAX_TOTAL_NOTES = 8000

export interface ContactContextResult {
  context: string
  hasMeetings: boolean
  hasEmails: boolean
  hasNotes: boolean
}

export function buildContactContext(contactId: string): ContactContextResult {
  const contact = contactRepo.getContact(contactId)
  if (!contact) throw new Error('Contact not found')

  const parts: string[] = []
  let hasMeetings = false
  let hasEmails = false
  let hasNotes = false

  // Contact overview
  parts.push(`# Contact: ${contact.fullName}`)
  const meta: string[] = []
  if (contact.title) meta.push(`Title: ${contact.title}`)
  if (contact.primaryCompany) meta.push(`Company: ${contact.primaryCompany.canonicalName}`)
  if (contact.contactType) meta.push(`Type: ${contact.contactType}`)
  if (meta.length) parts.push(meta.join(' | '))
  parts.push('')

  // Meeting summaries / transcripts
  const meetingsWithSummary = new Set<string>()
  const summaryParts: string[] = []
  let summaryTotal = 0

  for (const meetingRef of contact.meetings) {
    if (summaryTotal >= MAX_TOTAL_SUMMARIES) break
    const full = meetingRepo.getMeeting(meetingRef.id)
    if (!full?.summaryPath) continue
    const content = readSummary(full.summaryPath)
    if (!content) continue
    const excerpt = content.length > MAX_SUMMARY_CHARS ? content.substring(0, MAX_SUMMARY_CHARS) + '...' : content
    summaryParts.push(`### ${meetingRef.title} (${new Date(meetingRef.date).toLocaleDateString()})\n${excerpt}`)
    summaryTotal += excerpt.length
    meetingsWithSummary.add(meetingRef.id)
    hasMeetings = true
  }
  if (summaryParts.length > 0) {
    parts.push('## Meeting Summaries')
    parts.push(summaryParts.join('\n\n'))
    parts.push('')
  }

  // Transcripts for meetings without summaries
  const transcriptParts: string[] = []
  for (const meetingRef of contact.meetings) {
    if (meetingsWithSummary.has(meetingRef.id)) continue
    const full = meetingRepo.getMeeting(meetingRef.id)
    if (!full?.transcriptPath) continue
    const content = readTranscript(full.transcriptPath)
    if (!content) continue
    const excerpt = content.length > MAX_TRANSCRIPT_CHARS ? content.substring(0, MAX_TRANSCRIPT_CHARS) + '...' : content
    transcriptParts.push(`### ${meetingRef.title} (${new Date(meetingRef.date).toLocaleDateString()})\n${excerpt}`)
    hasMeetings = true
  }
  if (transcriptParts.length > 0) {
    parts.push('## Meeting Transcripts')
    parts.push(transcriptParts.join('\n\n'))
    parts.push('')
  }

  // Emails
  const emailRefs = contactRepo.listContactEmails(contactId).slice(0, 20)
  const emailParts: string[] = []
  let emailTotal = 0
  for (const e of emailRefs) {
    if (!e.bodyText || e.bodyText.trim().length < 50) continue
    if (emailTotal >= MAX_TOTAL_EMAILS) break
    const body = e.bodyText.length > MAX_EMAIL_BODY_CHARS ? e.bodyText.substring(0, MAX_EMAIL_BODY_CHARS) + '...' : e.bodyText
    const date = e.receivedAt || e.sentAt || ''
    emailParts.push(`From: ${e.fromEmail}\nSubject: ${e.subject || '(no subject)'}\nDate: ${date}\n\n${body}`)
    emailTotal += body.length
    hasEmails = true
  }
  if (emailParts.length > 0) {
    parts.push('## Email Correspondence')
    parts.push(emailParts.join('\n\n---\n\n'))
    parts.push('')
  }

  // Contact notes
  const notes = contactNotesRepo.listContactNotes(contactId)
  const noteParts: string[] = []
  let noteTotal = 0
  for (const note of notes) {
    if (!note.content || note.content.trim().length < 10) continue
    if (noteTotal >= MAX_TOTAL_NOTES) break
    const excerpt = note.content.length > MAX_NOTE_CHARS ? note.content.substring(0, MAX_NOTE_CHARS) + '...' : note.content
    const date = note.createdAt ? new Date(note.createdAt).toLocaleDateString() : ''
    noteParts.push(`${date ? `(${date}) ` : ''}${excerpt}`)
    noteTotal += excerpt.length
    hasNotes = true
  }
  if (noteParts.length > 0) {
    parts.push('## Notes')
    parts.push(noteParts.join('\n\n'))
    parts.push('')
  }

  return { context: parts.join('\n'), hasMeetings, hasEmails, hasNotes }
}
