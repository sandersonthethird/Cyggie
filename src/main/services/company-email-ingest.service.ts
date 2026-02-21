import { randomUUID } from 'crypto'
import { google, type gmail_v1 } from 'googleapis'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import {
  getGmailGrantedScopes,
  getGmailOAuth2Client,
  hasGmailScope,
  isGmailConnected
} from '../calendar/google-auth'
import type { CompanyEmailIngestResult } from '../../shared/types/company'

const MAX_CONTACT_CUES = 30
const MAX_EMAILS_PER_CONTACT_QUERY = 120
const MAX_EMAILS_PER_DOMAIN_QUERY = 180
const MAX_TOTAL_MATCHES = 800

interface CompanyIngestCues {
  companyId: string
  canonicalName: string
  contactEmails: string[]
  domains: string[]
}

interface QueryCue {
  query: string
  reason: string
  confidence: number
  maxResults: number
}

interface MessageCue {
  reason: string
  confidence: number
}

interface ParsedAddress {
  email: string
  displayName: string | null
}

interface ParsedMessage {
  providerMessageId: string
  providerThreadId: string
  internetMessageId: string | null
  direction: 'inbound' | 'outbound'
  subject: string | null
  fromName: string | null
  fromEmail: string
  replyTo: string | null
  sentAt: string | null
  receivedAt: string | null
  snippet: string | null
  bodyText: string | null
  labelsJson: string
  isUnread: number
  hasAttachments: number
  participants: Array<{
    role: 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'
    email: string
    displayName: string | null
  }>
}

function normalizeEmail(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^mailto:/, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

function normalizeDomain(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^www\./, '')
  if (!cleaned) return null
  return cleaned
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function extractDomainFromWebsiteUrl(websiteUrl: string | null): string | null {
  if (!websiteUrl) return null
  const trimmed = websiteUrl.trim()
  if (!trimmed) return null
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withScheme)
    return normalizeDomain(url.hostname)
  } catch {
    return null
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function splitHeaderList(value: string): string[] {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function parseAddressToken(token: string): ParsedAddress | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  const angle = trimmed.match(/^(.*?)<([^<>]+)>$/)
  if (angle) {
    const email = normalizeEmail(angle[2] || '')
    if (!email) return null
    const rawName = (angle[1] || '').trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
    return { email, displayName: rawName || null }
  }

  const directEmail = normalizeEmail(trimmed)
  if (directEmail) {
    return { email: directEmail, displayName: null }
  }

  const match = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (!match) return null
  const fallbackEmail = normalizeEmail(match[0] || '')
  if (!fallbackEmail) return null
  return { email: fallbackEmail, displayName: null }
}

function parseAddressList(value: string | null): ParsedAddress[] {
  if (!value) return []
  const map = new Map<string, ParsedAddress>()
  for (const token of splitHeaderList(value)) {
    const parsed = parseAddressToken(token)
    if (!parsed) continue
    if (!map.has(parsed.email)) {
      map.set(parsed.email, parsed)
      continue
    }
    const existing = map.get(parsed.email)
    if (existing && !existing.displayName && parsed.displayName) {
      map.set(parsed.email, parsed)
    }
  }
  return [...map.values()]
}

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | null | undefined,
  name: string
): string | null {
  if (!headers || headers.length === 0) return null
  const found = headers.find((header) => (header.name || '').toLowerCase() === name.toLowerCase())
  return (found?.value || '').trim() || null
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLength)
  return Buffer.from(padded, 'base64').toString('utf-8')
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractBodyTextAndAttachmentFlag(
  payload: gmail_v1.Schema$MessagePart | undefined
): { bodyText: string | null; hasAttachments: boolean } {
  if (!payload) return { bodyText: null, hasAttachments: false }

  const plainParts: string[] = []
  const htmlParts: string[] = []
  let hasAttachments = false

  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return
    if ((part.filename || '').trim()) {
      hasAttachments = true
    }

    const mimeType = (part.mimeType || '').toLowerCase()
    const bodyData = part.body?.data
    if (bodyData) {
      try {
        const decoded = decodeBase64Url(bodyData)
        if (mimeType === 'text/plain') {
          plainParts.push(decoded)
        } else if (mimeType === 'text/html') {
          htmlParts.push(decoded)
        }
      } catch {
        // Ignore malformed payload chunks.
      }
    }

    if (part.parts && part.parts.length > 0) {
      for (const child of part.parts) {
        walk(child)
      }
    }
  }

  walk(payload)

  const plainText = plainParts.join('\n').trim()
  if (plainText) {
    return { bodyText: plainText.slice(0, 100_000), hasAttachments }
  }

  const htmlText = stripHtml(htmlParts.join('\n'))
  return {
    bodyText: htmlText ? htmlText.slice(0, 100_000) : null,
    hasAttachments
  }
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function toIsoFromEpochMillis(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function parseGmailMessage(
  message: gmail_v1.Schema$Message,
  accountEmail: string
): ParsedMessage | null {
  const providerMessageId = (message.id || '').trim()
  if (!providerMessageId) return null

  const providerThreadId = (message.threadId || providerMessageId).trim()
  const headers = message.payload?.headers || []

  const from = parseAddressToken(getHeaderValue(headers, 'From') || '') || {
    email: accountEmail,
    displayName: null
  }
  const to = parseAddressList(getHeaderValue(headers, 'To'))
  const cc = parseAddressList(getHeaderValue(headers, 'Cc'))
  const bcc = parseAddressList(getHeaderValue(headers, 'Bcc'))
  const replyToAddresses = parseAddressList(getHeaderValue(headers, 'Reply-To'))

  const messageTime =
    toIsoFromEpochMillis(message.internalDate) || toIsoDate(getHeaderValue(headers, 'Date'))
  const direction: 'inbound' | 'outbound' =
    from.email === accountEmail ? 'outbound' : 'inbound'

  const sentAt = direction === 'outbound' ? messageTime : null
  const receivedAt = direction === 'inbound' ? messageTime : null

  const { bodyText, hasAttachments } = extractBodyTextAndAttachmentFlag(message.payload || undefined)
  const labels = (message.labelIds || []).filter((label): label is string => typeof label === 'string')

  const participants = new Map<string, ParsedMessage['participants'][number]>()
  const addParticipant = (
    role: ParsedMessage['participants'][number]['role'],
    address: ParsedAddress
  ) => {
    const key = `${role}:${address.email}`
    if (!participants.has(key)) {
      participants.set(key, {
        role,
        email: address.email,
        displayName: address.displayName
      })
    }
  }

  addParticipant('from', from)
  for (const address of to) addParticipant('to', address)
  for (const address of cc) addParticipant('cc', address)
  for (const address of bcc) addParticipant('bcc', address)
  for (const address of replyToAddresses) addParticipant('reply_to', address)

  return {
    providerMessageId,
    providerThreadId,
    internetMessageId: getHeaderValue(headers, 'Message-ID'),
    direction,
    subject: getHeaderValue(headers, 'Subject'),
    fromName: from.displayName,
    fromEmail: from.email,
    replyTo: replyToAddresses[0]?.email || null,
    sentAt,
    receivedAt,
    snippet: (message.snippet || '').trim() || null,
    bodyText: bodyText || (message.snippet || '').trim() || null,
    labelsJson: JSON.stringify(labels),
    isUnread: labels.includes('UNREAD') ? 1 : 0,
    hasAttachments: hasAttachments ? 1 : 0,
    participants: [...participants.values()]
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function buildQueryCues(cues: CompanyIngestCues): QueryCue[] {
  const queries: QueryCue[] = []

  for (const group of chunkArray(cues.contactEmails, 8)) {
    const parts = group.map((email) => `(from:${email} OR to:${email} OR cc:${email})`)
    queries.push({
      query: parts.join(' OR '),
      reason: `contacts:${group.length}`,
      confidence: 0.95,
      maxResults: MAX_EMAILS_PER_CONTACT_QUERY
    })
  }

  for (const domain of cues.domains) {
    queries.push({
      query: `(from:${domain} OR to:${domain} OR cc:${domain})`,
      reason: `domain:${domain}`,
      confidence: 0.82,
      maxResults: MAX_EMAILS_PER_DOMAIN_QUERY
    })
  }

  if (queries.length === 0 && cues.canonicalName.trim()) {
    const escapedName = cues.canonicalName.replace(/"/g, '').trim()
    if (escapedName) {
      queries.push({
        query: `"${escapedName}"`,
        reason: `name:${escapedName}`,
        confidence: 0.45,
        maxResults: 120
      })
    }
  }

  const deduped = new Map<string, QueryCue>()
  for (const query of queries) {
    if (!deduped.has(query.query)) {
      deduped.set(query.query, query)
    }
  }
  return [...deduped.values()]
}

async function listMessageIdsForQuery(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults: number
): Promise<string[]> {
  const messageIds: string[] = []
  let pageToken: string | undefined

  while (messageIds.length < maxResults) {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      includeSpamTrash: false,
      pageToken,
      maxResults: Math.min(100, maxResults - messageIds.length)
    })

    const messages = response.data.messages || []
    for (const message of messages) {
      if (message.id) {
        messageIds.push(message.id)
      }
    }

    if (!response.data.nextPageToken || messages.length === 0) {
      break
    }
    pageToken = response.data.nextPageToken
  }

  return messageIds
}

function loadCompanyIngestCues(db: Database.Database, companyId: string): CompanyIngestCues {
  const company = db
    .prepare(`
      SELECT id, canonical_name, primary_domain, website_url
      FROM org_companies
      WHERE id = ?
      LIMIT 1
    `)
    .get(companyId) as {
    id: string
    canonical_name: string
    primary_domain: string | null
    website_url: string | null
  } | undefined

  if (!company) {
    throw new Error('Company not found')
  }

  const contactRows = db
    .prepare(`
      SELECT DISTINCT LOWER(c.email) AS email
      FROM contacts c
      LEFT JOIN org_company_contacts occ ON occ.contact_id = c.id
      WHERE c.email IS NOT NULL
        AND (occ.company_id = ? OR c.primary_company_id = ?)
      ORDER BY c.updated_at DESC
      LIMIT ?
    `)
    .all(companyId, companyId, MAX_CONTACT_CUES) as Array<{ email: string }>

  const meetingRows = db
    .prepare(`
      SELECT m.attendee_emails
      FROM meetings m
      JOIN meeting_company_links l ON l.meeting_id = m.id
      WHERE l.company_id = ?
      ORDER BY datetime(m.date) DESC
      LIMIT 40
    `)
    .all(companyId) as Array<{ attendee_emails: string | null }>

  const contactEmails = uniqueStrings([
    ...contactRows
      .map((row) => normalizeEmail(row.email))
      .filter((email): email is string => Boolean(email)),
    ...meetingRows.flatMap((row) =>
      parseJsonStringArray(row.attendee_emails)
        .map((email) => normalizeEmail(email))
        .filter((email): email is string => Boolean(email))
    )
  ]).slice(0, MAX_CONTACT_CUES)

  const domains = uniqueStrings([
    normalizeDomain(company.primary_domain || '') || '',
    extractDomainFromWebsiteUrl(company.website_url) || ''
  ].filter(Boolean))

  return {
    companyId: company.id,
    canonicalName: company.canonical_name,
    contactEmails,
    domains
  }
}

function ensureEmailAccount(
  db: Database.Database,
  profile: gmail_v1.Schema$Profile
): { accountId: string; accountEmail: string; historyCursor: string | null } {
  const accountEmail = normalizeEmail(profile.emailAddress || '')
  if (!accountEmail) {
    throw new Error('Unable to resolve Gmail account email address')
  }

  const existing = db
    .prepare(`
      SELECT id
      FROM email_accounts
      WHERE provider = 'gmail' AND account_email = ?
      LIMIT 1
    `)
    .get(accountEmail) as { id: string } | undefined

  const scopesJson = JSON.stringify(getGmailGrantedScopes())
  if (!existing) {
    const accountId = randomUUID()
    db.prepare(`
      INSERT INTO email_accounts (
        id, provider, account_email, display_name, external_account_id, status,
        scopes_json, created_at, updated_at
      )
      VALUES (?, 'gmail', ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
    `).run(accountId, accountEmail, accountEmail, accountEmail, scopesJson)
    return {
      accountId,
      accountEmail,
      historyCursor: profile.historyId || null
    }
  }

  db.prepare(`
    UPDATE email_accounts
    SET
      status = 'active',
      scopes_json = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(scopesJson, existing.id)

  return {
    accountId: existing.id,
    accountEmail,
    historyCursor: profile.historyId || null
  }
}

function markSyncStarted(db: Database.Database, accountId: string): void {
  const existing = db
    .prepare(`
      SELECT id
      FROM email_sync_state
      WHERE account_id = ? AND mailbox = 'INBOX'
      LIMIT 1
    `)
    .get(accountId) as { id: string } | undefined

  if (!existing) {
    db.prepare(`
      INSERT INTO email_sync_state (
        id, account_id, mailbox, last_sync_started_at, last_error, created_at, updated_at
      )
      VALUES (?, ?, 'INBOX', datetime('now'), NULL, datetime('now'), datetime('now'))
    `).run(randomUUID(), accountId)
    return
  }

  db.prepare(`
    UPDATE email_sync_state
    SET
      last_sync_started_at = datetime('now'),
      last_error = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(existing.id)
}

function markSyncCompleted(db: Database.Database, accountId: string, cursor: string | null): void {
  db.prepare(`
    UPDATE email_sync_state
    SET
      cursor = COALESCE(?, cursor),
      last_sync_completed_at = datetime('now'),
      last_error = NULL,
      updated_at = datetime('now')
    WHERE account_id = ? AND mailbox = 'INBOX'
  `).run(cursor, accountId)

  db.prepare(`
    UPDATE email_accounts
    SET last_synced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(accountId)
}

function markSyncFailed(db: Database.Database, accountId: string | null, errorMessage: string): void {
  if (!accountId) return
  db.prepare(`
    UPDATE email_sync_state
    SET
      last_error = ?,
      updated_at = datetime('now')
    WHERE account_id = ? AND mailbox = 'INBOX'
  `).run(errorMessage.slice(0, 1000), accountId)
}

function normalizeGmailIngestError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()

  if (
    lowerMessage.includes('gmail api has not been used in project') ||
    (lowerMessage.includes('gmail.googleapis.com') && lowerMessage.includes('disabled'))
  ) {
    const projectMatch = message.match(/project\s+([0-9]+)/i)
    const projectId = projectMatch?.[1]
    if (projectId) {
      return new Error(
        `Gmail API is disabled for your Google Cloud project (${projectId}). Enable Gmail API in the Cloud Console, wait a few minutes, then retry.`
      )
    }
    return new Error(
      'Gmail API is disabled for your Google Cloud project. Enable Gmail API in the Cloud Console, wait a few minutes, then retry.'
    )
  }

  if (lowerMessage.includes('insufficient authentication scopes')) {
    return new Error(
      'Gmail permission is missing. Reconnect Gmail in Settings and grant "View your email messages and settings".'
    )
  }

  if (lowerMessage.includes('invalid_grant') || lowerMessage.includes('token has been expired')) {
    return new Error('Google token expired or revoked. Reconnect Gmail in Settings and try again.')
  }

  return new Error(message)
}

export async function ingestCompanyEmails(companyId: string): Promise<CompanyEmailIngestResult> {
  if (!companyId) {
    throw new Error('companyId is required')
  }

  if (!isGmailConnected()) {
    throw new Error('Gmail is not connected. Connect Gmail in Settings first.')
  }

  if (!hasGmailScope()) {
    throw new Error('Gmail read access is not granted. Reconnect Gmail in Settings to grant email access.')
  }

  const auth = getGmailOAuth2Client()
  if (!auth) {
    throw new Error('Google OAuth client is unavailable')
  }

  const gmail = google.gmail({ version: 'v1', auth })
  const db = getDatabase()
  const cues = loadCompanyIngestCues(db, companyId)
  const queries = buildQueryCues(cues)
  if (queries.length === 0) {
    throw new Error('No contact or domain cues found for this company. Add company contacts or domain first.')
  }

  let accountId: string | null = null

  try {
    const profileResponse = await gmail.users.getProfile({ userId: 'me' })
    const account = ensureEmailAccount(db, profileResponse.data)
    accountId = account.accountId
    markSyncStarted(db, account.accountId)

    const messageCueByProviderId = new Map<string, MessageCue>()
    for (const query of queries) {
      if (messageCueByProviderId.size >= MAX_TOTAL_MATCHES) break
      const remaining = MAX_TOTAL_MATCHES - messageCueByProviderId.size
      const ids = await listMessageIdsForQuery(
        gmail,
        query.query,
        Math.min(query.maxResults, remaining)
      )
      for (const id of ids) {
        const existing = messageCueByProviderId.get(id)
        if (!existing || query.confidence > existing.confidence) {
          messageCueByProviderId.set(id, {
            reason: query.reason,
            confidence: query.confidence
          })
        }
      }
    }

    const selectThread = db.prepare(`
      SELECT id, subject, snippet, first_message_at, last_message_at
      FROM email_threads
      WHERE account_id = ? AND provider_thread_id = ?
      LIMIT 1
    `)
    const insertThread = db.prepare(`
      INSERT INTO email_threads (
        id, account_id, provider_thread_id, subject, snippet, first_message_at, last_message_at,
        message_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `)
    const updateThread = db.prepare(`
      UPDATE email_threads
      SET
        subject = ?,
        snippet = ?,
        first_message_at = ?,
        last_message_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)
    const bumpThreadMessageCount = db.prepare(`
      UPDATE email_threads
      SET message_count = message_count + 1, updated_at = datetime('now')
      WHERE id = ?
    `)

    const selectMessage = db.prepare(`
      SELECT id
      FROM email_messages
      WHERE account_id = ? AND provider_message_id = ?
      LIMIT 1
    `)
    const insertMessage = db.prepare(`
      INSERT INTO email_messages (
        id, account_id, thread_id, provider_message_id, internet_message_id, direction,
        subject, from_name, from_email, reply_to, sent_at, received_at, snippet, body_text,
        labels_json, is_unread, has_attachments, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    const updateMessage = db.prepare(`
      UPDATE email_messages
      SET
        thread_id = ?,
        internet_message_id = ?,
        direction = ?,
        subject = ?,
        from_name = ?,
        from_email = ?,
        reply_to = ?,
        sent_at = ?,
        received_at = ?,
        snippet = ?,
        body_text = ?,
        labels_json = ?,
        is_unread = ?,
        has_attachments = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)

    const selectContactByEmail = db.prepare(`
      SELECT id
      FROM contacts
      WHERE lower(email) = ?
      LIMIT 1
    `)
    const upsertParticipant = db.prepare(`
      INSERT INTO email_message_participants (
        message_id, role, email, display_name, contact_id, domain, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(message_id, role, email) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, email_message_participants.display_name),
        contact_id = COALESCE(excluded.contact_id, email_message_participants.contact_id),
        domain = excluded.domain
    `)
    const upsertCompanyLink = db.prepare(`
      INSERT INTO email_company_links (
        message_id, company_id, confidence, linked_by, reason, created_at
      )
      VALUES (?, ?, ?, 'auto', ?, datetime('now'))
      ON CONFLICT(message_id, company_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > email_company_links.confidence THEN excluded.confidence
          ELSE email_company_links.confidence
        END,
        linked_by = excluded.linked_by,
        reason = excluded.reason
    `)
    const upsertContactLink = db.prepare(`
      INSERT INTO email_contact_links (
        message_id, contact_id, confidence, linked_by, created_at
      )
      VALUES (?, ?, ?, 'auto', datetime('now'))
      ON CONFLICT(message_id, contact_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > email_contact_links.confidence THEN excluded.confidence
          ELSE email_contact_links.confidence
        END,
        linked_by = excluded.linked_by
    `)

    let insertedMessageCount = 0
    let updatedMessageCount = 0
    let linkedMessageCount = 0
    let linkedContactCount = 0

    for (const [providerMessageId, cue] of messageCueByProviderId.entries()) {
      let fullMessage: gmail_v1.Schema$Message
      try {
        const response = await gmail.users.messages.get({
          userId: 'me',
          id: providerMessageId,
          format: 'full'
        })
        fullMessage = response.data
      } catch (err) {
        console.warn('[Company Email Ingest] Failed to fetch message:', providerMessageId, err)
        continue
      }

      const parsed = parseGmailMessage(fullMessage, account.accountEmail)
      if (!parsed) continue

      const messageTimestamp = parsed.receivedAt || parsed.sentAt
      const existingThread = selectThread.get(
        account.accountId,
        parsed.providerThreadId
      ) as {
        id: string
        subject: string | null
        snippet: string | null
        first_message_at: string | null
        last_message_at: string | null
      } | undefined

      let threadId = existingThread?.id || null
      if (!threadId) {
        threadId = randomUUID()
        insertThread.run(
          threadId,
          account.accountId,
          parsed.providerThreadId,
          parsed.subject,
          parsed.snippet,
          messageTimestamp,
          messageTimestamp
        )
      } else {
        const currentFirst = existingThread.first_message_at
        const currentLast = existingThread.last_message_at
        const nextFirst = !currentFirst
          ? messageTimestamp
          : !messageTimestamp
            ? currentFirst
            : new Date(messageTimestamp).getTime() < new Date(currentFirst).getTime()
              ? messageTimestamp
              : currentFirst
        const nextLast = !currentLast
          ? messageTimestamp
          : !messageTimestamp
            ? currentLast
            : new Date(messageTimestamp).getTime() > new Date(currentLast).getTime()
              ? messageTimestamp
              : currentLast
        updateThread.run(
          parsed.subject || existingThread.subject,
          parsed.snippet || existingThread.snippet,
          nextFirst,
          nextLast,
          threadId
        )
      }

      const existingMessage = selectMessage.get(
        account.accountId,
        parsed.providerMessageId
      ) as { id: string } | undefined
      let messageId = existingMessage?.id || null
      let inserted = false

      if (!messageId) {
        messageId = randomUUID()
        insertMessage.run(
          messageId,
          account.accountId,
          threadId,
          parsed.providerMessageId,
          parsed.internetMessageId,
          parsed.direction,
          parsed.subject,
          parsed.fromName,
          parsed.fromEmail,
          parsed.replyTo,
          parsed.sentAt,
          parsed.receivedAt,
          parsed.snippet,
          parsed.bodyText,
          parsed.labelsJson,
          parsed.isUnread,
          parsed.hasAttachments
        )
        inserted = true
        insertedMessageCount += 1
      } else {
        updateMessage.run(
          threadId,
          parsed.internetMessageId,
          parsed.direction,
          parsed.subject,
          parsed.fromName,
          parsed.fromEmail,
          parsed.replyTo,
          parsed.sentAt,
          parsed.receivedAt,
          parsed.snippet,
          parsed.bodyText,
          parsed.labelsJson,
          parsed.isUnread,
          parsed.hasAttachments,
          messageId
        )
        updatedMessageCount += 1
      }

      if (inserted && threadId) {
        bumpThreadMessageCount.run(threadId)
      }

      const linkedContactIds = new Set<string>()
      for (const participant of parsed.participants) {
        const participantDomain = participant.email.split('@')[1] || null
        const contact = selectContactByEmail.get(participant.email) as { id: string } | undefined
        upsertParticipant.run(
          messageId,
          participant.role,
          participant.email,
          participant.displayName,
          contact?.id || null,
          participantDomain
        )
        if (contact?.id) {
          linkedContactIds.add(contact.id)
        }
      }

      const companyLinkResult = upsertCompanyLink.run(
        messageId,
        companyId,
        cue.confidence,
        cue.reason
      )
      if (companyLinkResult.changes > 0) {
        linkedMessageCount += 1
      }

      for (const contactId of linkedContactIds) {
        const contactLinkResult = upsertContactLink.run(messageId, contactId, 0.95)
        linkedContactCount += contactLinkResult.changes
      }
    }

    markSyncCompleted(db, account.accountId, account.historyCursor)

    return {
      companyId,
      accountEmail: account.accountEmail,
      cues: {
        contactEmails: cues.contactEmails,
        domains: cues.domains
      },
      queryCount: queries.length,
      fetchedMessageCount: messageCueByProviderId.size,
      insertedMessageCount,
      updatedMessageCount,
      linkedMessageCount,
      linkedContactCount
    }
  } catch (err) {
    const normalizedError = normalizeGmailIngestError(err)
    markSyncFailed(db, accountId, normalizedError.message)
    throw normalizedError
  }
}
