import { ipcMain, shell, dialog } from 'electron'
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { readTranscript, readSummary, updateTranscriptContent, updateSummaryContent, deleteTranscript, deleteSummary, deleteRecording, renameTranscript, renameSummary, renameRecording } from '../storage/file-manager'
import { recoverSummaryFromCompanionNote } from '@cyggie/services/meeting-summary-recovery'
import { removeFromIndex } from '@cyggie/db/sqlite/repositories/search.repo'
import { getStoragePath, setStoragePath } from '../storage/paths'
import { renameFile as renameDriveFile } from '../drive/google-drive'
import { extractCompaniesFromEmails, extractCompaniesFromAttendees, extractDomainFromEmail } from '../utils/company-extractor'
import { enrichCompaniesForMeeting, getCompanySuggestionsForMeeting } from '../services/company-enrichment'
import { syncContactsFromAttendees } from '@cyggie/db/sqlite/repositories'
import { computeAutoGroupEventFlag, shouldSyncAttendees } from '@cyggie/db/sqlite/repositories'
import { GROUP_EVENT_ATTENDEE_THRESHOLD } from '@cyggie/shared'
import {
  flagFile,
  isFlaggedAnywhere,
} from '@cyggie/db/sqlite/repositories'
import { notifyPending as notifyExtractionWorker } from '../services/flagged-file-extraction-worker'
import { linkMeetingCompany, getCompany, findCompanyIdByNameOrDomain, unlinkMeetingCompany, getOrCreateCompanyByName, listMeetingCompanies, updateCompany } from '@cyggie/db/sqlite/repositories'
import { upsert as upsertCompanyCache, getByDomain as getCompanyCacheByDomain } from '@cyggie/db/sqlite/repositories/company.repo'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import type { Meeting, MeetingListFilter } from '../../shared/types/meeting'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'
import { getCurrentUserId, getCurrentUserProfile } from '../security/current-user'
import { getUser } from '@cyggie/db/sqlite/repositories/user.repo'
import { logAudit } from '@cyggie/db/sqlite/repositories/audit.repo'

/**
 * Best-effort derivation of `selfName` from a user's local SQLite record.
 * Used as the fallback when a meeting isn't created from a calendar event
 * (manual recording, MEETING_CREATE) or the calendar payload lacked a
 * `selfName` (e.g. older renderer call sites).
 *
 * Mirrors the COALESCE chain in migration 107's backfill so meetings
 * created post-migration look the same as backfilled rows: displayName →
 * "first last" → email → null.
 */
function deriveSelfNameFromUser(userId: string | null): string | null {
  if (!userId) return null
  const user = getUser(userId)
  if (!user) return null
  const display = user.displayName?.trim()
  if (display) return display
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  if (full) return full
  const email = user.email?.trim()
  if (email) return email
  return null
}

const execFileP = promisify(execFile)

/**
 * Rewrites the speaker-header lines in a transcript markdown file so they
 * match `newSpeakerMap`. Shared by MEETING_RENAME_SPEAKERS (free-text
 * rename) and MEETING_TAG_SPEAKER_CONTACT (link/unlink a CRM contact) —
 * both mutate `meeting.speakerMap` and both must propagate the change into
 * the saved markdown body, otherwise the chip shows the new name but the
 * transcript text still shows the old one.
 *
 * The file may be out of sync with the DB speakerMap (e.g. from a prior
 * file collision), so we scan the file for actual names and fall back to
 * the default "Speaker N" label or an orphan match.
 */
function rewriteTranscriptSpeakers(
  transcriptPath: string | null | undefined,
  oldSpeakerMap: Record<number, string>,
  newSpeakerMap: Record<number, string>,
): void {
  if (!transcriptPath) return
  let content = readTranscript(transcriptPath)
  if (!content) return

  const fileNames = new Set<string>()
  const headerPattern = /^\*\*(.+?)\*\* \[/gm
  let match
  while ((match = headerPattern.exec(content)) !== null) {
    fileNames.add(match[1])
  }

  const newNameValues = new Set(Object.values(newSpeakerMap))
  let changed = false

  for (const [index, newName] of Object.entries(newSpeakerMap)) {
    const idx = Number(index)
    // Skip when the file already has the new name — that's the "in sync"
    // condition. (Don't gate on `dbName === newName`: if a prior write
    // updated the DB but never reached the file, the divergence has to
    // heal here on the next link/rename.)
    if (fileNames.has(newName)) continue

    const dbName = oldSpeakerMap[idx]
    let fileOldName: string | undefined
    if (dbName && fileNames.has(dbName)) {
      fileOldName = dbName
    } else if (fileNames.has(`Speaker ${idx + 1}`)) {
      fileOldName = `Speaker ${idx + 1}`
    } else {
      for (const fname of fileNames) {
        if (!newNameValues.has(fname)) {
          fileOldName = fname
          break
        }
      }
    }

    if (fileOldName && fileOldName !== newName) {
      const escaped = fileOldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`^\\*\\*${escaped}\\*\\*`, 'gm')
      content = content.replace(pattern, `**${newName}**`)
      fileNames.delete(fileOldName)
      fileNames.add(newName)
      changed = true
    }
  }

  if (changed) updateTranscriptContent(transcriptPath, content)
}

const TWITTER_HOSTS = new Set([
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
  'x.com', 'www.x.com', 'mobile.x.com'
])

// macOS only: read the bundle ID of whichever app currently handles https://
async function getDefaultBrowserBundleId(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('defaults', [
      'read',
      'com.apple.LaunchServices/com.apple.launchservices.secure',
      'LSHandlers'
    ])
    for (const block of stdout.split(/\}\s*,?/)) {
      if (/LSHandlerURLScheme\s*=\s*"?https"?/.test(block)) {
        const m = block.match(/LSHandlerRoleAll\s*=\s*"?([\w.\-]+)"?/)
        if (m) return m[1]
      }
    }
  } catch {
    // ignore
  }
  return null
}

async function openInDefaultBrowser(url: string): Promise<boolean> {
  const bundleId = (await getDefaultBrowserBundleId()) ?? 'com.apple.Safari'
  // AppleScript "open location" sends the URL straight to the target browser
  // via Apple Events, which never consults LaunchServices — so the X app's
  // Universal Links registration on twitter.com / x.com cannot intercept it.
  const safeUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const safeBundle = bundleId.replace(/"/g, '\\"')
  const script = `tell application id "${safeBundle}" to open location "${safeUrl}"`
  try {
    await execFileP('osascript', ['-e', script])
    return true
  } catch {
    // Fall back to `open -b`, which is still better than shell.openExternal
    // (which routes through NSWorkspace and triggers Universal Links).
    try {
      spawn('open', ['-b', bundleId, url], { detached: true, stdio: 'ignore' }).unref()
      return true
    } catch {
      return false
    }
  }
}

// Pure helpers — exported for unit testing
export function mergeSpeakerTag(
  speakerMap: Record<number, string>,
  contactMap: Record<number, string>,
  index: number,
  contactId: string,
  contactName: string
): { speakerMap: Record<number, string>; contactMap: Record<number, string> } {
  return {
    speakerMap: { ...speakerMap, [index]: contactName },
    contactMap: { ...contactMap, [index]: contactId }
  }
}

export function removeSpeakerTag(
  speakerMap: Record<number, string>,
  contactMap: Record<number, string>,
  index: number
): { speakerMap: Record<number, string>; contactMap: Record<number, string> } {
  const newContactMap = { ...contactMap }
  delete newContactMap[index]
  return {
    speakerMap: { ...speakerMap, [index]: `Speaker ${index + 1}` },
    contactMap: newContactMap
  }
}

export function appendCompanyIfMissing(companies: string[] | null, canonicalName: string): string[] {
  const arr = companies ?? []
  return arr.includes(canonicalName) ? arr : [...arr, canonicalName]
}

function removeCompanyFromList(companies: string[] | null, canonicalName: string): string[] {
  if (!companies) return []
  return companies.filter((n) => n.toLowerCase() !== canonicalName.toLowerCase())
}

/**
 * Re-point a meeting from one company to another (a re-attribution: the meeting
 * was actually with a *different* company). Creates the target if needed,
 * unlinks the old company from THIS meeting only, and leaves the old company
 * otherwise intact. Use renameMeetingCompany() instead when the user is
 * correcting a company's name — that propagates to every surface.
 */
export function swapMeetingCompany(
  meetingId: string,
  oldCompanyId: string | null,
  newCompanyName: string,
  userId: string | null,
): Meeting {
  const meeting = meetingRepo.getMeeting(meetingId)
  if (!meeting) throw new Error('Meeting not found')

  // Find or create the target company
  const newCompany = getOrCreateCompanyByName(newCompanyName.trim(), userId)

  // Unlink old company if it exists and is different from the new one
  if (oldCompanyId && oldCompanyId !== newCompany.id) {
    const oldCompany = getCompany(oldCompanyId)
    if (oldCompany) {
      unlinkMeetingCompany(meetingId, oldCompanyId)
      const stripped = removeCompanyFromList(meeting.companies, oldCompany.canonicalName)
      meetingRepo.updateMeeting(meetingId, { companies: stripped }, userId)
      logAudit(userId, 'meeting', meetingId, 'unlink_company', { companyId: oldCompanyId })

      // Update the domain→name cache so email-derived suggestions reflect the swap.
      // We update any domain that currently maps to the old company's name — this
      // covers both the old company's primary domain and email domains for this meeting
      // (e.g. angellist.com was cached as "Wellfound" → now maps to "AngelList").
      const domainsToUpdate = new Set<string>()
      if (oldCompany.primaryDomain) domainsToUpdate.add(oldCompany.primaryDomain)
      for (const email of (meeting.attendeeEmails ?? [])) {
        const d = extractDomainFromEmail(email)
        if (d) {
          const cached = getCompanyCacheByDomain(d)
          if (cached && cached.displayName === oldCompany.canonicalName) domainsToUpdate.add(d)
        }
      }
      for (const d of domainsToUpdate) {
        upsertCompanyCache(d, newCompany.canonicalName)
      }
    }
  }

  // Link new company (idempotent — INSERT OR IGNORE in linkMeetingCompany)
  linkMeetingCompany(meetingId, newCompany.id, 1, 'manual', userId)
  const refreshed = meetingRepo.getMeeting(meetingId)!
  const updated = appendCompanyIfMissing(refreshed.companies, newCompany.canonicalName)
  if (updated !== refreshed.companies) {
    meetingRepo.updateMeeting(meetingId, { companies: updated }, userId)
  }

  logAudit(userId, 'meeting', meetingId, 'swap_company', { oldCompanyId, newCompanyId: newCompany.id })
  return meetingRepo.getMeeting(meetingId)!
}

/**
 * Correct a linked company's NAME from the meeting detail surface and propagate
 * the new name to every other surface (other meetings, contacts, the domain
 * cache) via updateCompany()'s single-source-of-truth rename cascade.
 *
 * The meeting chip is the surface users are most likely to fix a bad
 * auto-derived name on (it sits on their calendar), so a fix here must not
 * strand the old company under its wrong name — which is what swapMeetingCompany
 * would do. If the typed name already belongs to a *different* company, this is
 * really a re-attribution, so we fall back to a swap rather than collide on the
 * unique normalized_name.
 */
export function renameMeetingCompany(
  meetingId: string,
  companyId: string,
  newName: string,
  userId: string | null,
): Meeting {
  const meeting = meetingRepo.getMeeting(meetingId)
  if (!meeting) throw new Error('Meeting not found')
  const company = getCompany(companyId)
  if (!company) throw new Error('Company not found')

  // If another company already owns this name, the user means "this meeting is
  // actually that company" — re-point instead of renaming (avoids a unique
  // normalized_name collision and global mis-rename).
  const existingId = findCompanyIdByNameOrDomain(newName.trim(), null)
  if (existingId && existingId !== companyId) {
    return swapMeetingCompany(meetingId, companyId, newName, userId)
  }

  // True rename — cascades to meetings.companies (incl. this meeting),
  // contacts.previous_companies, and the legacy domain cache.
  updateCompany(companyId, { canonicalName: newName.trim() }, userId)
  logAudit(userId, 'company', companyId, 'update', {
    via: 'meeting', meetingId, rename: { from: company.canonicalName, to: newName.trim() },
  })
  return meetingRepo.getMeeting(meetingId)!
}

/**
 * Idempotently create a `'scheduled'` meeting row from a calendar event.
 *
 * Three callers:
 *   1. MEETING_PREPARE IPC — user taps "Prepare" on a calendar badge.
 *   2. meeting-notifier — toast fires (~2 min lead window).
 *   3. calendar reconcile — past-event backfill on calendar fetch.
 *
 * All three converge on the same invariant: any calendar event the user
 * has crossed paths with becomes a SQLite meeting row. The
 * `findMeetingByCalendarEventId` guard makes repeat calls a no-op.
 *
 * Side effects (only on first creation, when !isGroupEvent):
 *   - logAudit('meeting', id, 'create')
 *   - syncContactsFromAttendees (fire-and-forget on failure)
 *   - enrichCompaniesForMeeting (fire-and-forget)
 *
 * NOTE: the redundant `syncContactsFromAttendees` call that used to live
 * inline in MEETING_PREPARE was removed (migration 098 / plan Part 2). It
 * re-ran against unchanged stored attendees on every calendar poll and was
 * the primary resurrection vector for user-deleted contacts. Re-syncing
 * only happens on attendee CHANGE via MEETING_UPDATE.
 */
export function prepareMeetingFromCalendarEvent(
  event: {
    id: string
    title: string
    startTime: string
    platform: MeetingPlatform | null
    meetingUrl: string | null
    location?: string | null
    attendees: string[]
    attendeeEmails: string[]
    // Optional: callers with a full CalendarEvent forward this from
    // google-calendar.ts's `selfName` extraction. Older renderer call
    // sites that don't have it fall back to the local user record.
    selfName?: string | null
  },
  userId: string | null,
): Meeting {
  const existing = meetingRepo.findMeetingByCalendarEventId(event.id)
  if (existing) return existing

  const companies = event.attendeeEmails.length > 0
    ? extractCompaniesFromEmails(event.attendeeEmails)
    : extractCompaniesFromAttendees(event.attendees)

  const isGroupEvent = event.attendeeEmails.length > GROUP_EVENT_ATTENDEE_THRESHOLD
  console.info(
    `[meeting:autoflag] meetingId=new attendeeCount=${event.attendeeEmails.length} value=${isGroupEvent} metric=meeting.group_event.autoflag count=1`,
  )
  const meeting = meetingRepo.createMeeting({
    title: event.title,
    date: event.startTime,
    calendarEventId: event.id,
    meetingPlatform: event.platform,
    meetingUrl: event.meetingUrl,
    location: event.location?.trim() ? event.location : null,
    attendees: event.attendees.length > 0 ? event.attendees : null,
    attendeeEmails: event.attendeeEmails.length > 0 ? event.attendeeEmails : null,
    selfName: event.selfName ?? deriveSelfNameFromUser(userId),
    companies: isGroupEvent ? null : (companies.length > 0 ? companies : null),
    status: 'scheduled',
    isGroupEvent,
  }, userId)
  logAudit(userId, 'meeting', meeting.id, 'create', {
    source: 'calendar-prepare',
    calendarEventId: event.id,
    isGroupEvent,
  })

  if (!isGroupEvent) {
    try {
      syncContactsFromAttendees(meeting.attendees, meeting.attendeeEmails, userId)
    } catch (err) {
      console.error('[Contacts] Failed to sync from prepared meeting:', err)
    }

    const emails = event.attendeeEmails.length > 0
      ? event.attendeeEmails
      : event.attendees.filter((a) => a.includes('@'))
    if (emails.length > 0) {
      enrichCompaniesForMeeting(meeting.id, emails).catch((err) =>
        console.error('[Company Enrichment] Failed:', err),
      )
    }
  }

  return meeting
}

export function registerMeetingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MEETING_LIST, (_event, filter?: MeetingListFilter) => {
    return meetingRepo.listMeetings(filter)
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_GET, (_event, id: string) => {
    const meeting = meetingRepo.getMeeting(id)
    if (!meeting) return null

    const transcript = meeting.transcriptPath ? readTranscript(meeting.transcriptPath) : null
    let summary = meeting.summaryPath ? readSummary(meeting.summaryPath) : null

    const db = getDatabase()
    const linkedCompanies = db
      .prepare(`
        SELECT c.id, c.canonical_name AS name
        FROM meeting_company_links l
        JOIN org_companies c ON c.id = l.company_id
        WHERE l.meeting_id = ?
        ORDER BY c.canonical_name
      `)
      .all(id) as { id: string; name: string }[]

    // Recover summary from companion notes only when the summary file is genuinely
    // missing (readSummary returns null). An empty file means the user has
    // emptied the summary; restoring stale companion-note content would silently
    // overwrite that intent and any prior edits.
    if (summary === null && meeting.status === 'summarized') {
      summary = recoverSummaryFromCompanionNote(meeting)
    }

    return { meeting, transcript, summary, linkedCompanies }
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_UPDATE, (_event, id: string, data: Parameters<typeof meetingRepo.updateMeeting>[1]) => {
    const userId = getCurrentUserId()

    // Group-event auto-flag recompute (migration 098). When attendees change
    // AND the user hasn't explicitly toggled the flag, recompute it from the
    // new count. user_set=true → locked, never recomputed here.
    const attendeesChanged = data.attendees !== undefined || data.attendeeEmails !== undefined
    if (attendeesChanged && data.isGroupEvent === undefined) {
      const before = meetingRepo.getMeeting(id)
      if (before) {
        const newEmails = data.attendeeEmails !== undefined
          ? (data.attendeeEmails ?? [])
          : (before.attendeeEmails ?? [])
        const recomputed = computeAutoGroupEventFlag(
          newEmails.length,
          before.isGroupEventUserSet,
          before.isGroupEvent,
          GROUP_EVENT_ATTENDEE_THRESHOLD,
        )
        if (recomputed !== null) {
          data = { ...data, isGroupEvent: recomputed }
        }
      }
    }

    const updated = meetingRepo.updateMeeting(id, data, userId)
    if (updated && attendeesChanged && shouldSyncAttendees(id)) {
      try {
        syncContactsFromAttendees(updated.attendees, updated.attendeeEmails, userId)
      } catch (err) {
        console.error('[Contacts] Failed to sync from meeting update:', err)
      }
    }
    if (updated) {
      logAudit(userId, 'meeting', id, 'update', data)
    }
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_DELETE, (_event, id: string) => {
    const userId = getCurrentUserId()
    const meeting = meetingRepo.getMeeting(id)
    if (meeting) {
      if (meeting.transcriptPath) deleteTranscript(meeting.transcriptPath)
      if (meeting.summaryPath) deleteSummary(meeting.summaryPath)
      if (meeting.recordingPath) deleteRecording(meeting.recordingPath)
      removeFromIndex(id)
    }
    // Delete empty companion notes before the meeting is removed.
    // Notes with user-written content are preserved as standalone notes (ON DELETE SET NULL).
    const db = getDatabase()
    db.prepare("DELETE FROM notes WHERE source_meeting_id = ? AND TRIM(content) = ''").run(id)
    const deleted = meetingRepo.deleteMeeting(id)
    if (deleted) {
      logAudit(userId, 'meeting', id, 'delete', null)
    }
    return deleted
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_SPEAKERS,
    (_event, id: string, newSpeakerMap: Record<number, string>) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const oldSpeakerMap = meeting.speakerMap

      meetingRepo.updateMeeting(id, { speakerMap: newSpeakerMap }, userId)
      rewriteTranscriptSpeakers(meeting.transcriptPath, oldSpeakerMap, newSpeakerMap)

      logAudit(userId, 'meeting', id, 'update', { speakerMap: newSpeakerMap })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SET_ME_SPEAKER,
    (_event, id: string, nextValue: number | null) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      // Caller computes the new value; the IPC handler just persists.
      // Keeping the resolver logic in the renderer (where it composes
      // with the transcript view) avoids a second main-side imports
      // path for me-them-resolver and keeps this handler a thin
      // write-through.
      const value =
        nextValue == null || !Number.isFinite(nextValue) ? null : Math.trunc(nextValue)
      meetingRepo.updateMeeting(id, { meSpeakerIndex: value }, userId)
      logAudit(userId, 'meeting', id, 'update', { meSpeakerIndex: value })
      return meetingRepo.getMeeting(id)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_TITLE,
    (_event, id: string, newTitle: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const trimmed = newTitle.trim()
      if (!trimmed || trimmed === meeting.title) return meeting

      const updates: Parameters<typeof meetingRepo.updateMeeting>[1] = { title: trimmed }

      if (meeting.transcriptPath) {
        updates.transcriptPath = renameTranscript(meeting.transcriptPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.summaryPath) {
        updates.summaryPath = renameSummary(meeting.summaryPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.recordingPath) {
        updates.recordingPath = renameRecording(meeting.recordingPath, id, trimmed, meeting.date, meeting.attendees)
      }

      meetingRepo.updateMeeting(id, updates, userId)

      // Rename Drive files if they exist (fire-and-forget)
      if (meeting.transcriptDriveId && updates.transcriptPath) {
        renameDriveFile(meeting.transcriptDriveId, updates.transcriptPath).catch((err) =>
          console.error('[Drive] Failed to rename transcript:', err)
        )
      }
      if (meeting.summaryDriveId && updates.summaryPath) {
        renameDriveFile(meeting.summaryDriveId, updates.summaryPath).catch((err) =>
          console.error('[Drive] Failed to rename summary:', err)
        )
      }

      logAudit(userId, 'meeting', id, 'update', { title: trimmed })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_NOTES,
    (_event, id: string, notes: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      const noteUpdates: Parameters<typeof meetingRepo.updateMeeting>[1] = { notes: notes || null }
      meetingRepo.updateMeeting(id, noteUpdates, userId)
      logAudit(userId, 'meeting', id, 'update', { notes: Boolean(notes) })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_SUMMARY,
    (_event, id: string, summaryContent: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      if (!meeting.summaryPath) throw new Error('Meeting has no summary file')
      updateSummaryContent(meeting.summaryPath, summaryContent)
      meetingRepo.updateMeeting(id, { summaryPath: meeting.summaryPath }, userId)
      logAudit(userId, 'meeting', id, 'update', { summaryEdited: true })
      return meetingRepo.getMeeting(id)
    }
  )

  // MEETING_SAVE_CHAT is a no-op: chat persistence now flows through the
  // chat_sessions infrastructure (see withChatPersistence in chat.ipc.ts).
  // The legacy meetings.chat_messages column is read-only; backfilled into
  // chat_sessions by migration 080.
  ipcMain.handle(IPC_CHANNELS.MEETING_SAVE_CHAT, () => {})

  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE, () => {
    const userId = getCurrentUserId()
    const meeting = meetingRepo.createMeeting({
      title: `Note ${new Date().toLocaleDateString()}`,
      date: new Date().toISOString(),
      selfName: deriveSelfNameFromUser(userId),
      status: 'scheduled'
    }, userId)
    logAudit(userId, 'meeting', meeting.id, 'create', { source: 'manual-note' })
    return meeting
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_PREPARE,
    (_event, calendarEventId: string, title: string, date: string, platform?: string, meetingUrl?: string, attendees?: string[], attendeeEmails?: string[]) => {
      return prepareMeetingFromCalendarEvent({
        id: calendarEventId,
        title,
        startTime: date,
        platform: (platform as MeetingPlatform) || null,
        meetingUrl: meetingUrl || null,
        attendees: attendees ?? [],
        attendeeEmails: attendeeEmails ?? [],
      }, getCurrentUserId())
    }
  )

  // Group-event manual toggle (migration 098). Sets is_group_event +
  // is_group_event_user_set atomically via updateMeeting. When un-flagging a
  // previously-flagged meeting, also recomputes companies from attendee emails
  // (which triggers syncMeetingCompanyLinks inside updateMeeting) and runs a
  // one-shot syncContactsFromAttendees (subject to per-email tombstones).
  ipcMain.handle(
    IPC_CHANNELS.MEETING_SET_GROUP_EVENT,
    (_event, meetingId: string, isGroupEvent: boolean) => {
      const userId = getCurrentUserId()
      if (!userId) throw new Error('not signed in')
      const before = meetingRepo.getMeeting(meetingId)
      if (!before) throw new Error('meeting not found')

      // When un-flagging a previously-flagged meeting, derive companies from
      // the stored attendee emails so meeting_company_links repopulates.
      const isUnflagging = before.isGroupEvent && !isGroupEvent
      const recomputedCompanies = isUnflagging && before.attendeeEmails && before.attendeeEmails.length > 0
        ? extractCompaniesFromEmails(before.attendeeEmails)
        : undefined

      const updated = meetingRepo.updateMeeting(
        meetingId,
        {
          isGroupEvent,
          isGroupEventUserSet: true,
          ...(recomputedCompanies !== undefined ? { companies: recomputedCompanies } : {}),
        },
        userId,
      )
      logAudit(userId, 'meeting', meetingId, 'set_group_event', {
        from: before.isGroupEvent,
        to: isGroupEvent,
      })
      console.info(
        `[meeting:setGroupEvent] meetingId=${meetingId} value=${isGroupEvent} userId=${userId} metric=meeting.group_event.toggle count=1`,
      )

      // Off-after-on: deferred sync once. Tombstoned emails won't recreate.
      if (isUnflagging && updated && (updated.attendeeEmails?.length ?? 0) > 0) {
        try {
          syncContactsFromAttendees(updated.attendees, updated.attendeeEmails, userId)
        } catch (err) {
          console.error('[Contacts] Failed deferred sync after un-flag:', err)
        }
      }

      return updated
    }
  )

  // Company enrichment: trigger enrichment for a specific meeting
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_ENRICH_MEETING,
    async (_event, meetingId: string) => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) return { success: false, error: 'not_found', message: 'Meeting not found' }

      const emails = meeting.attendeeEmails || (meeting.attendees || []).filter((a) => a.includes('@'))
      if (emails.length === 0) return { success: true }

      await enrichCompaniesForMeeting(meetingId, emails)
      return { success: true }
    }
  )

  // Company suggestions: get CompanySuggestion[] for a meeting
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_GET_SUGGESTIONS,
    (_event, meetingId: string) => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) return []
      const suggestions = getCompanySuggestionsForMeeting(meeting.attendeeEmails, meeting.companies)
      const enriched = suggestions.map((s) => {
        const id = findCompanyIdByNameOrDomain(s.name, s.domain) ?? undefined
        return id ? { ...s, id } : s
      })

      // Merge in manually linked companies that aren't already represented
      const linkedCompanies = listMeetingCompanies(meetingId)
      const existingIds = new Set(enriched.filter((s) => s.id).map((s) => s.id))
      for (const company of linkedCompanies) {
        if (!existingIds.has(company.id)) {
          enriched.push({
            id: company.id,
            name: company.canonicalName,
            domain: company.primaryDomain ?? '',
            entityType: company.entityType ?? null
          })
        }
      }

      // Filter out dismissed companies (by domain or name)
      const dismissed = new Set(
        (meeting.dismissedCompanies ?? []).map(d => d.toLowerCase())
      )
      if (dismissed.size === 0) return enriched
      return enriched.filter(s => {
        if (s.domain && dismissed.has(s.domain.toLowerCase())) return false
        if (dismissed.has(s.name.toLowerCase())) return false
        return true
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_STORAGE_DIR, () => {
    shell.openPath(getStoragePath())
  })

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, async (_event, rawUrl: string) => {
    if (typeof rawUrl !== 'string') {
      throw new Error('URL must be a string')
    }
    const trimmed = rawUrl.trim()
    if (!trimmed) {
      throw new Error('URL is required')
    }
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withProtocol)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed')
    }
    // Inject authuser for Google Meet so the browser opens with the configured account
    if (parsed.hostname === 'meet.google.com') {
      try {
        const email = getCurrentUserProfile().email
        if (email) parsed.searchParams.set('authuser', email)
      } catch {
        // Non-fatal: open without authuser if profile unavailable
      }
    }
    // The X (Twitter) macOS app claims Universal Links for twitter.com / x.com,
    // so shell.openExternal opens both the browser AND the app. Force these URLs
    // into the user's default browser by targeting it directly.
    if (process.platform === 'darwin' && TWITTER_HOSTS.has(parsed.hostname)) {
      const opened = await openInDefaultBrowser(parsed.toString())
      if (opened) return
    }
    return shell.openExternal(parsed.toString())
  })

  // APP_OPEN_FLAGGED_FILE — capability-scoped replacement for APP_OPEN_PATH.
  // The renderer passes a flagged-file id (Drive id or local path); main only
  // opens it if it has a row in `company_flagged_files`. When companyId is
  // provided AND the id isn't already flagged, auto-flag first (parallel to
  // FILE_READ_BY_FLAGGED_ID — same UX preservation for "open the file the
  // user clicked in the listing").
  ipcMain.handle(
    IPC_CHANNELS.APP_OPEN_FLAGGED_FILE,
    async (
      _event,
      args: { id: string; companyId?: string; fileName?: string; mimeType?: string | null },
    ) => {
      if (!args || typeof args !== 'object' || typeof args.id !== 'string' || !args.id.trim()) {
        throw new Error('Flagged-file id is required')
      }
      const { id, companyId, fileName, mimeType } = args
      if (companyId) {
        // Phase 3: flagFile is idempotent (no-op when already flagged);
        // when it inserts a new row, kick the worker so the file's text
        // is extracted in time for the next chat query.
        const userId = getCurrentUserId()
        const inserted = flagFile({
          companyId,
          fileId: id,
          fileName: fileName ?? id,
          mimeType: mimeType ?? null,
          userId,
          flaggedByUserId: userId,
        })
        if (inserted) notifyExtractionWorker()
      } else if (!isFlaggedAnywhere(id)) {
        throw new Error('File is not flagged and no companyId provided to auto-flag')
      }
      return shell.openPath(id)
    },
  )

  // APP_OPEN_USER_FOLDER — open a directory path stored in a setting. The
  // renderer passes the setting NAME (not the path); main reads the setting
  // and validates the resolved value is an existing directory before opening.
  // Today only `companyLocalFilesRoot` is supported.
  //
  // Residual risk: an XSS can still call SETTINGS_SET to tamper the value
  // before triggering open. The isDirectory check catches the obvious cases
  // (`/etc/passwd` is a file, not a dir); the stronger fix
  // (`SETTINGS_PICK_AND_SET_FOLDER` — a trusted-picker channel) is tracked
  // in TODOS.md (P2 — Security).
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_USER_FOLDER, async (_event, which: string) => {
    if (which !== 'companyLocalFilesRoot') {
      throw new Error(`Unsupported user-folder key: ${which}`)
    }
    const path = settingsRepo.getSetting(which)
    if (!path || !path.trim()) {
      throw new Error(`Setting '${which}' is not configured`)
    }
    let stat
    try {
      stat = statSync(path)
    } catch {
      throw new Error(`Path does not exist: ${path}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${path}`)
    }
    return shell.openPath(path)
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_STORAGE_PATH, () => {
    return getStoragePath()
  })

  ipcMain.handle(IPC_CHANNELS.APP_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.APP_PICK_LOGO_FILE, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose logo image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const ext = extname(filePath).slice(1).toLowerCase()
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp'
    }
    const mime = mimeMap[ext] || 'image/png'
    const buf = readFileSync(filePath)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle(IPC_CHANNELS.APP_CHANGE_STORAGE_DIR, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose storage directory',
      defaultPath: getStoragePath(),
      properties: ['openDirectory', 'createDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const newPath = result.filePaths[0]
    setStoragePath(newPath)
    settingsRepo.setSetting('storagePath', newPath)
    return newPath
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_TAG_SPEAKER_CONTACT,
    (
      _event,
      meetingId: string,
      speakerIndex: number,
      contactId: string | null,
      contactName: string | null
    ) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!Number.isInteger(speakerIndex) || speakerIndex < 0) throw new Error('speakerIndex must be a non-negative integer')
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const db = getDatabase()

      if (contactId && contactName) {
        // LINK: rename speaker + insert join row + auto-tag companion note.
        // All three writes go through wrapped repo functions so each owned-
        // table mutation emits its own outbox row and reaches Neon.
        const updatedSpeakerMap = { ...meeting.speakerMap, [speakerIndex]: contactName }
        const updated = meetingRepo.updateMeeting(meetingId, { speakerMap: updatedSpeakerMap }, userId)
        if (!updated) throw new Error('Failed to update meeting')

        meetingRepo.linkMeetingSpeakerContact(meetingId, speakerIndex, contactId)
        rewriteTranscriptSpeakers(meeting.transcriptPath, meeting.speakerMap, updatedSpeakerMap)

        // Auto-tag companion note (first-link-wins, non-fatal). Uses the
        // wrapped tagNote so the contact_id propagates to mobile.
        try {
          const companionNote = db
            .prepare('SELECT id, contact_id FROM notes WHERE source_meeting_id = ? LIMIT 1')
            .get(meetingId) as { id: string; contact_id: string | null } | undefined
          if (companionNote && !companionNote.contact_id) {
            meetingRepo.tagNote(companionNote.id, { contactId })
          }
        } catch (err) {
          console.warn('[MeetingDetail] Failed to auto-tag companion note:', err)
        }

        logAudit(userId, 'meeting', meetingId, 'tag_speaker_contact', { speakerIndex, contactId })
      } else {
        // UNLINK: reset speaker name + delete join row. The default label
        // is 1-indexed to match buildSpeakerMap and the renderer fallback,
        // and so the transcript-body rewrite finds the existing "Speaker N"
        // header (which is also 1-indexed).
        const defaultName = `Speaker ${speakerIndex + 1}`
        const updatedSpeakerMap = { ...meeting.speakerMap, [speakerIndex]: defaultName }
        const updated = meetingRepo.updateMeeting(meetingId, { speakerMap: updatedSpeakerMap }, userId)
        if (!updated) throw new Error('Failed to update meeting')

        meetingRepo.unlinkMeetingSpeakerContact(meetingId, speakerIndex)
        rewriteTranscriptSpeakers(meeting.transcriptPath, meeting.speakerMap, updatedSpeakerMap)

        logAudit(userId, 'meeting', meetingId, 'untag_speaker_contact', { speakerIndex })
      }

      return meetingRepo.getMeeting(meetingId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_LINK_EXISTING_COMPANY,
    (_event, meetingId: string, companyId: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()

      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const company = getCompany(companyId)
      if (!company) throw new Error('Company not found')

      linkMeetingCompany(meetingId, companyId, 1, 'manual', userId)

      // Update the denormalized companies cache on the meeting row
      const updatedCompanies = appendCompanyIfMissing(meeting.companies, company.canonicalName)

      // Remove from dismissed list if previously dismissed
      const dismissKey = (company.primaryDomain || company.canonicalName).toLowerCase()
      const dismissed = meeting.dismissedCompanies ?? []
      const updatedDismissed = dismissed.filter(
        d => d !== dismissKey && d !== company.canonicalName.toLowerCase()
      )

      meetingRepo.updateMeeting(meetingId, {
        companies: updatedCompanies,
        dismissedCompanies: updatedDismissed.length ? updatedDismissed : null,
      }, userId)

      logAudit(userId, 'meeting', meetingId, 'link_company', { companyId })
      return meetingRepo.getMeeting(meetingId)
    }
  )

  // Unlink a company from a meeting. Accepts either:
  //   (meetingId, companyId, displayName?, displayDomain?)
  //   (meetingId, null, displayName, displayDomain?)  — dismiss a name-only suggestion
  //
  // displayName / displayDomain are what the user actually saw in the chip
  // (derived from attendee email domains in `getCompanySuggestionsFromEmails`).
  // We dismiss by every key the rebuilt suggestion might use — display name,
  // display domain, canonical name, and primary domain — because the suggestion
  // on reload is keyed off the email's domain, which may not match the
  // org_companies.primary_domain (e.g. babson.com vs babson.edu). Without this,
  // clicking X dismisses by primary_domain but the email-derived suggestion
  // resurrects with a different domain.
  ipcMain.handle(
    IPC_CHANNELS.MEETING_UNLINK_COMPANY,
    (
      _event,
      meetingId: string,
      companyId: string | null,
      displayName?: string,
      displayDomain?: string,
    ) => {
      if (!meetingId) throw new Error('meetingId is required')
      const userId = getCurrentUserId()

      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const newKeys: string[] = []
      const addKey = (k: string | null | undefined) => {
        const v = k?.trim().toLowerCase()
        if (v && !newKeys.includes(v)) newKeys.push(v)
      }

      let canonicalForList: string | null = null

      if (companyId) {
        const company = getCompany(companyId)
        if (!company) throw new Error('Company not found')

        unlinkMeetingCompany(meetingId, companyId)
        canonicalForList = company.canonicalName
        addKey(company.primaryDomain)
        addKey(company.canonicalName)
        logAudit(userId, 'meeting', meetingId, 'unlink_company', { companyId })
      } else if (!displayName) {
        throw new Error('Either companyId or displayName is required')
      }

      addKey(displayDomain)
      addKey(displayName)

      const targetForCache = canonicalForList ?? displayName ?? ''
      const updatedCompanies = targetForCache
        ? removeCompanyFromList(meeting.companies, targetForCache)
        : (meeting.companies ?? [])

      const existing = meeting.dismissedCompanies ?? []
      const merged = [...existing]
      for (const k of newKeys) if (!merged.includes(k)) merged.push(k)

      meetingRepo.updateMeeting(meetingId, {
        companies: updatedCompanies,
        dismissedCompanies: merged.length ? merged : null,
      }, userId)

      if (!companyId) {
        logAudit(userId, 'meeting', meetingId, 'dismiss_company_suggestion', {
          displayName,
          displayDomain,
        })
      }

      return meetingRepo.getMeeting(meetingId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SWAP_COMPANY,
    (_event, meetingId: string, oldCompanyId: string | null, newCompanyName: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!newCompanyName?.trim()) throw new Error('newCompanyName is required')
      return swapMeetingCompany(meetingId, oldCompanyId, newCompanyName, getCurrentUserId())
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_COMPANY,
    (_event, meetingId: string, companyId: string, newName: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!companyId) throw new Error('companyId is required')
      if (!newName?.trim()) throw new Error('newName is required')
      return renameMeetingCompany(meetingId, companyId, newName, getCurrentUserId())
    }
  )
}
