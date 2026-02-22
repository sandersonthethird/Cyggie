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
import { findCompanyIdByDomain } from '../database/repositories/org-company.repo'
import type { CompanyEmailIngestResult } from '../../shared/types/company'
import type { ContactEmailIngestResult } from '../../shared/types/contact'

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

interface ContactIngestCues {
  contactId: string
  contactEmail: string
  contactEmails: string[]
  contactFullName: string
  primaryCompanyId: string | null
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

function normalizePersonName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitFullNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length !== 2) {
    return { firstName: null, lastName: null }
  }

  return {
    firstName: tokens[0] || null,
    lastName: tokens[1] || null
  }
}

function compactPersonName(value: string): string {
  return normalizePersonName(value).replace(/\s+/g, '')
}

function inferNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || email
  const words = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  return words.length > 0 ? words.join(' ') : email
}

function resolveContactName(displayName: string | null | undefined, email: string): string {
  return sanitizeSenderDisplayName(displayName) || inferNameFromEmail(email)
}

function shouldPromoteContactName(existingName: string | null, candidateName: string): boolean {
  const existingNormalized = normalizePersonName(existingName || '')
  const candidateNormalized = normalizePersonName(candidateName)
  if (!candidateNormalized) return false
  if (!existingNormalized) return true
  if (candidateNormalized === existingNormalized) return false

  const existingCompact = compactPersonName(existingName || '')
  const candidateCompact = compactPersonName(candidateName)
  const existingTokenCount = existingNormalized.split(' ').filter(Boolean).length
  const candidateTokenCount = candidateNormalized.split(' ').filter(Boolean).length

  if (candidateTokenCount < existingTokenCount) return false

  const relatedByWordMatch = candidateNormalized.includes(existingNormalized)
    || existingNormalized.includes(candidateNormalized)
  const relatedByCompactMatch = candidateCompact === existingCompact
    || candidateCompact.includes(existingCompact)
    || existingCompact.includes(candidateCompact)

  if (!relatedByWordMatch && !relatedByCompactMatch && existingTokenCount >= 2) {
    return false
  }

  if (candidateTokenCount > existingTokenCount) return true
  return candidateNormalized.length > existingNormalized.length
}

function sanitizeSenderDisplayName(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (normalizeEmail(cleaned)) return null
  return cleaned
}

function selectExpandedContactName(
  currentFullName: string,
  senderNames: Set<string>
): string | null {
  const normalizedCurrent = normalizePersonName(currentFullName)
  const compactCurrent = compactPersonName(currentFullName)
  const currentTokenCount = normalizedCurrent.split(' ').filter(Boolean).length
  let selected: { raw: string; normalized: string } | null = null

  for (const senderName of senderNames) {
    const cleaned = sanitizeSenderDisplayName(senderName)
    if (!cleaned) continue

    const normalized = normalizePersonName(cleaned)
    const compact = compactPersonName(cleaned)
    if (!normalized || normalized === normalizedCurrent) continue

    const tokenCount = normalized.split(' ').filter(Boolean).length
    if (tokenCount < 2) continue

    if (normalizedCurrent) {
      const relatedByWordMatch = normalized.includes(normalizedCurrent)
      const relatedByCompactMatch = compactCurrent
        ? (compact === compactCurrent || compact.includes(compactCurrent))
        : false
      if (!relatedByWordMatch && !relatedByCompactMatch) continue

      const improvedByLength = normalized.length > normalizedCurrent.length
      const improvedByTokens = tokenCount > currentTokenCount
      if (!improvedByLength && !improvedByTokens) continue
    }

    if (!selected) {
      selected = { raw: cleaned, normalized }
      continue
    }

    if (normalized.length > selected.normalized.length) {
      selected = { raw: cleaned, normalized }
    }
  }

  return selected?.raw ?? null
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

function resolveCompanyForDomain(domain: string | null | undefined): string | null {
  const normalized = normalizeDomain(domain || '')
  if (!normalized) return null
  return findCompanyIdByDomain(normalized)
}

function assignPrimaryCompanyIfUnset(
  db: Database.Database,
  contactId: string,
  companyId: string | null
): string | null {
  if (!companyId) return null

  const result = db.prepare(`
    UPDATE contacts
    SET primary_company_id = ?, updated_at = datetime('now')
    WHERE id = ? AND (primary_company_id IS NULL OR TRIM(primary_company_id) = '')
  `).run(companyId, contactId)

  if (result.changes > 0) {
    db.prepare(`
      INSERT INTO org_company_contacts (
        company_id, contact_id, is_primary, created_at
      )
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(company_id, contact_id) DO UPDATE SET
        is_primary = 1
    `).run(companyId, contactId)
  }

  const row = db
    .prepare('SELECT primary_company_id FROM contacts WHERE id = ?')
    .get(contactId) as { primary_company_id: string | null } | undefined
  return row?.primary_company_id ?? null
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

  // Prefer explicit contact emails. Domain queries are only used as a fallback
  // when no associated contacts are available.
  if (cues.contactEmails.length > 0) {
    for (const group of chunkArray(cues.contactEmails, 8)) {
      const parts = group.map((email) => `(from:${email} OR to:${email} OR cc:${email})`)
      queries.push({
        query: parts.join(' OR '),
        reason: `contacts:${group.length}`,
        confidence: 0.95,
        maxResults: MAX_EMAILS_PER_CONTACT_QUERY
      })
    }
  } else {
    for (const domain of cues.domains) {
      queries.push({
        query: `(from:${domain} OR to:${domain} OR cc:${domain})`,
        reason: `domain:${domain}`,
        confidence: 0.82,
        maxResults: MAX_EMAILS_PER_DOMAIN_QUERY
      })
    }
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
      SELECT DISTINCT LOWER(COALESCE(ce.email, c.email)) AS email
      FROM contacts c
      LEFT JOIN contact_emails ce ON ce.contact_id = c.id
      LEFT JOIN org_company_contacts occ ON occ.contact_id = c.id
      WHERE COALESCE(ce.email, c.email) IS NOT NULL
        AND (occ.company_id = ? OR c.primary_company_id = ?)
      ORDER BY c.updated_at DESC
      LIMIT ?
    `)
    .all(companyId, companyId, MAX_CONTACT_CUES) as Array<{ email: string }>

  const contactEmails = uniqueStrings([
    ...contactRows
      .map((row) => normalizeEmail(row.email))
      .filter((email): email is string => Boolean(email))
  ]).slice(0, MAX_CONTACT_CUES)

  const aliasDomainRows = db
    .prepare(`
      SELECT alias_value
      FROM org_company_aliases
      WHERE company_id = ?
        AND alias_type = 'domain'
      ORDER BY datetime(created_at) ASC
      LIMIT 50
    `)
    .all(companyId) as Array<{ alias_value: string }>

  const domains = uniqueStrings([
    normalizeDomain(company.primary_domain || '') || '',
    extractDomainFromWebsiteUrl(company.website_url) || '',
    ...aliasDomainRows
      .map((row) => normalizeDomain(row.alias_value))
      .filter((value): value is string => Boolean(value))
  ].filter(Boolean))

  return {
    companyId: company.id,
    canonicalName: company.canonical_name,
    contactEmails,
    domains
  }
}

function loadContactIngestCues(db: Database.Database, contactId: string): ContactIngestCues {
  const contact = db
    .prepare(`
      SELECT id, email, full_name, primary_company_id
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `)
    .get(contactId) as {
    id: string
    email: string | null
    full_name: string | null
    primary_company_id: string | null
  } | undefined

  if (!contact) {
    throw new Error('Contact not found')
  }

  const contactEmailRows = db
    .prepare(`
      SELECT email
      FROM contact_emails
      WHERE contact_id = ?
      ORDER BY is_primary DESC, datetime(created_at) ASC, email ASC
    `)
    .all(contactId) as Array<{ email: string }>

  const contactEmails = uniqueStrings([
    ...contactEmailRows
      .map((row) => normalizeEmail(row.email))
      .filter((email): email is string => Boolean(email)),
    normalizeEmail(contact.email || '') || ''
  ].filter(Boolean))

  const contactEmail = contactEmails[0] || null
  if (!contactEmail) {
    throw new Error('Contact has no valid email address to ingest.')
  }

  return {
    contactId: contact.id,
    contactEmail,
    contactEmails,
    contactFullName: (contact.full_name || '').trim(),
    primaryCompanyId: contact.primary_company_id ?? null
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
    throw new Error('No associated contacts found for this company. Add company contacts (preferred) or set a primary domain for fallback.')
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
      SELECT c.id, c.full_name, c.first_name, c.last_name, c.normalized_name, c.primary_company_id, c.email
      FROM contacts c
      WHERE lower(c.email) = ?
        OR EXISTS (
          SELECT 1
          FROM contact_emails ce
          WHERE ce.contact_id = c.id AND lower(ce.email) = ?
        )
      LIMIT 1
    `)
    const insertContact = db.prepare(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, normalized_name, email, primary_company_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    const upsertContactEmail = db.prepare(`
      INSERT INTO contact_emails (contact_id, email, is_primary, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(contact_id, email) DO UPDATE SET
        is_primary = CASE
          WHEN excluded.is_primary = 1 THEN 1
          ELSE contact_emails.is_primary
        END
    `)
    const updateContactPrimaryEmail = db.prepare(`
      UPDATE contacts
      SET email = ?, updated_at = datetime('now')
      WHERE id = ? AND (email IS NULL OR TRIM(email) = '')
    `)
    const updateContactName = db.prepare(`
      UPDATE contacts
      SET
        full_name = ?,
        first_name = ?,
        last_name = ?,
        normalized_name = ?,
        updated_at = datetime('now')
      WHERE id = ?
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

    const ensureContactForParticipant = (
      email: string,
      displayName: string | null
    ): { id: string; primaryCompanyId: string | null } | null => {
      if (email === account.accountEmail) return null

      const existing = selectContactByEmail.get(email, email) as {
        id: string
        full_name: string
        first_name: string | null
        last_name: string | null
        normalized_name: string
        primary_company_id: string | null
        email: string | null
      } | undefined

      const candidateName = resolveContactName(displayName, email)
      const candidateNormalizedName = normalizePersonName(candidateName)
      const candidateSplitName = splitFullNameParts(candidateName)
      const emailDomain = normalizeDomain(email.split('@')[1] || '')
      const inferredCompanyId = resolveCompanyForDomain(emailDomain)

      if (!existing) {
        const contactId = randomUUID()
        insertContact.run(
          contactId,
          candidateName,
          candidateSplitName.firstName,
          candidateSplitName.lastName,
          candidateNormalizedName,
          email,
          inferredCompanyId
        )
        upsertContactEmail.run(contactId, email, 1)
        const primaryCompanyId = assignPrimaryCompanyIfUnset(db, contactId, inferredCompanyId)
        return { id: contactId, primaryCompanyId: primaryCompanyId ?? inferredCompanyId ?? null }
      }

      if (!normalizeEmail(existing.email || '')) {
        updateContactPrimaryEmail.run(email, existing.id)
      }
      upsertContactEmail.run(
        existing.id,
        email,
        normalizeEmail(existing.email || '') === email ? 1 : 0
      )

      if (shouldPromoteContactName(existing.full_name, candidateName)) {
        updateContactName.run(
          candidateName,
          candidateSplitName.firstName,
          candidateSplitName.lastName,
          candidateNormalizedName,
          existing.id
        )
      }

      const primaryCompanyId = existing.primary_company_id
        ? existing.primary_company_id
        : assignPrimaryCompanyIfUnset(db, existing.id, inferredCompanyId)

      return {
        id: existing.id,
        primaryCompanyId: primaryCompanyId ?? null
      }
    }

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
        const contact = ensureContactForParticipant(participant.email, participant.displayName)
        upsertParticipant.run(
          messageId,
          participant.role,
          participant.email,
          participant.displayName,
          contact?.id ?? null,
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

export async function ingestContactEmails(contactId: string): Promise<ContactEmailIngestResult> {
  if (!contactId) {
    throw new Error('contactId is required')
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
  const cues = loadContactIngestCues(db, contactId)
  const queries: QueryCue[] = chunkArray(cues.contactEmails, 8).map((group) => {
    const groupQuery = group
      .map((email) => `(from:${email} OR to:${email} OR cc:${email} OR bcc:${email})`)
      .join(' OR ')
    return {
      query: groupQuery,
      reason: `contact:${group.length}`,
      confidence: 0.98,
      maxResults: MAX_TOTAL_MATCHES
    }
  })

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
      SELECT c.id, c.full_name, c.first_name, c.last_name, c.normalized_name, c.primary_company_id, c.email
      FROM contacts c
      WHERE lower(c.email) = ?
        OR EXISTS (
          SELECT 1
          FROM contact_emails ce
          WHERE ce.contact_id = c.id AND lower(ce.email) = ?
        )
      LIMIT 1
    `)
    const insertContact = db.prepare(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, normalized_name, email, primary_company_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    const upsertContactEmail = db.prepare(`
      INSERT INTO contact_emails (contact_id, email, is_primary, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(contact_id, email) DO UPDATE SET
        is_primary = CASE
          WHEN excluded.is_primary = 1 THEN 1
          ELSE contact_emails.is_primary
        END
    `)
    const updateContactPrimaryEmail = db.prepare(`
      UPDATE contacts
      SET email = ?, updated_at = datetime('now')
      WHERE id = ? AND (email IS NULL OR TRIM(email) = '')
    `)
    const updateContactName = db.prepare(`
      UPDATE contacts
      SET
        full_name = ?,
        first_name = ?,
        last_name = ?,
        normalized_name = ?,
        updated_at = datetime('now')
      WHERE id = ?
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

    const ensureContactForParticipant = (
      email: string,
      displayName: string | null
    ): { id: string; primaryCompanyId: string | null } | null => {
      if (email === account.accountEmail) return null

      const existing = selectContactByEmail.get(email, email) as {
        id: string
        full_name: string
        first_name: string | null
        last_name: string | null
        normalized_name: string
        primary_company_id: string | null
        email: string | null
      } | undefined

      const candidateName = resolveContactName(displayName, email)
      const candidateNormalizedName = normalizePersonName(candidateName)
      const candidateSplitName = splitFullNameParts(candidateName)
      const emailDomain = normalizeDomain(email.split('@')[1] || '')
      const inferredCompanyId = resolveCompanyForDomain(emailDomain)

      if (!existing) {
        const contactId = randomUUID()
        insertContact.run(
          contactId,
          candidateName,
          candidateSplitName.firstName,
          candidateSplitName.lastName,
          candidateNormalizedName,
          email,
          inferredCompanyId
        )
        upsertContactEmail.run(contactId, email, 1)
        const primaryCompanyId = assignPrimaryCompanyIfUnset(db, contactId, inferredCompanyId)
        return { id: contactId, primaryCompanyId: primaryCompanyId ?? inferredCompanyId ?? null }
      }

      if (!normalizeEmail(existing.email || '')) {
        updateContactPrimaryEmail.run(email, existing.id)
      }
      upsertContactEmail.run(
        existing.id,
        email,
        normalizeEmail(existing.email || '') === email ? 1 : 0
      )

      if (shouldPromoteContactName(existing.full_name, candidateName)) {
        updateContactName.run(
          candidateName,
          candidateSplitName.firstName,
          candidateSplitName.lastName,
          candidateNormalizedName,
          existing.id
        )
      }

      const primaryCompanyId = existing.primary_company_id
        ? existing.primary_company_id
        : assignPrimaryCompanyIfUnset(db, existing.id, inferredCompanyId)

      return {
        id: existing.id,
        primaryCompanyId: primaryCompanyId ?? null
      }
    }

    let insertedMessageCount = 0
    let updatedMessageCount = 0
    let linkedMessageCount = 0
    let linkedContactCount = 0
    const senderNamesForTargetContact = new Set<string>()
    const cueContactEmailSet = new Set(cues.contactEmails)

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
        console.warn('[Contact Email Ingest] Failed to fetch message:', providerMessageId, err)
        continue
      }

      const parsed = parseGmailMessage(fullMessage, account.accountEmail)
      if (!parsed) continue
      if (cueContactEmailSet.has(parsed.fromEmail) && parsed.fromName) {
        senderNamesForTargetContact.add(parsed.fromName)
      }

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
      const linkedCompanyIds = new Set<string>()
      if (cues.primaryCompanyId) {
        linkedCompanyIds.add(cues.primaryCompanyId)
      }
      for (const participant of parsed.participants) {
        const participantDomain = participant.email.split('@')[1] || null
        const contact = ensureContactForParticipant(participant.email, participant.displayName)
        upsertParticipant.run(
          messageId,
          participant.role,
          participant.email,
          participant.displayName,
          contact?.id ?? null,
          participantDomain
        )
        if (contact?.id) {
          linkedContactIds.add(contact.id)
        }
        if (contact?.primaryCompanyId) {
          linkedCompanyIds.add(contact.primaryCompanyId)
        }
        if (participantDomain) {
          const companyByDomain = resolveCompanyForDomain(participantDomain)
          if (companyByDomain) {
            linkedCompanyIds.add(companyByDomain)
          }
        }
      }

      const targetContactLinkResult = upsertContactLink.run(messageId, contactId, cue.confidence)
      if (targetContactLinkResult.changes > 0) {
        linkedMessageCount += 1
      }

      for (const linkedContactId of linkedContactIds) {
        const contactLinkResult = upsertContactLink.run(messageId, linkedContactId, 0.95)
        linkedContactCount += contactLinkResult.changes
      }

      for (const linkedCompanyId of linkedCompanyIds) {
        const confidence = linkedCompanyId === cues.primaryCompanyId ? cue.confidence : 0.75
        upsertCompanyLink.run(messageId, linkedCompanyId, confidence, `contact:${cues.contactEmail}`)
      }
    }

    markSyncCompleted(db, account.accountId, account.historyCursor)
    const suggestedFullName = selectExpandedContactName(
      cues.contactFullName,
      senderNamesForTargetContact
    )

    return {
      contactId,
      contactEmail: cues.contactEmail,
      accountEmail: account.accountEmail,
      queryCount: queries.length,
      fetchedMessageCount: messageCueByProviderId.size,
      insertedMessageCount,
      updatedMessageCount,
      linkedMessageCount,
      linkedContactCount,
      suggestedFullName
    }
  } catch (err) {
    const normalizedError = normalizeGmailIngestError(err)
    markSyncFailed(db, accountId, normalizedError.message)
    throw normalizedError
  }
}
