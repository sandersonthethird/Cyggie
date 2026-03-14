import { vi, describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Declare before vi.mock so the factory closes over the binding
let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// Import after mock registration (vi.mock is hoisted above imports automatically)
const { getCompanyEmailById } = await import('../main/database/repositories/org-company.repo')

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT 'acct1',
      thread_id TEXT,
      provider_message_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'inbound',
      subject TEXT,
      from_name TEXT,
      from_email TEXT NOT NULL,
      reply_to TEXT,
      sent_at TEXT,
      received_at TEXT,
      snippet TEXT,
      body_text TEXT,
      labels_json TEXT,
      is_unread INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      artifact_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE email_message_participants (
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      contact_id TEXT,
      domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, role, email)
    );

    -- Required for LEFT JOIN in getCompanyEmailById participant subquery
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT
    );
  `)
  return db
}

describe('getCompanyEmailById', () => {
  beforeEach(() => {
    testDb = makeDb()
  })

  it('returns null for a non-existent message id', () => {
    const result = getCompanyEmailById('does-not-exist')
    expect(result).toBeNull()
  })

  it('returns a CompanyEmailRef with correct fields for an existing email', () => {
    testDb
      .prepare(
        `INSERT INTO email_messages
          (id, from_email, from_name, subject, received_at, snippet, body_text, is_unread, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'msg-001',
        'alice@example.com',
        'Alice',
        'Hello World',
        '2026-01-01T12:00:00',
        'Hi there',
        'Hi there, full body.',
        1,
        'thread-001'
      )

    const result = getCompanyEmailById('msg-001')

    expect(result).not.toBeNull()
    expect(result!.id).toBe('msg-001')
    expect(result!.fromEmail).toBe('alice@example.com')
    expect(result!.fromName).toBe('Alice')
    expect(result!.subject).toBe('Hello World')
    expect(result!.receivedAt).toBe('2026-01-01T12:00:00')
    expect(result!.snippet).toBe('Hi there')
    expect(result!.bodyText).toBe('Hi there, full body.')
    expect(result!.isUnread).toBe(true)
    expect(result!.threadId).toBe('thread-001')
    expect(result!.threadMessageCount).toBe(1)
    expect(result!.participants).toEqual([])
  })

  it('returns isUnread: false when is_unread is 0', () => {
    testDb
      .prepare(`INSERT INTO email_messages (id, from_email, is_unread) VALUES (?, ?, ?)`)
      .run('msg-read', 'x@example.com', 0)

    const result = getCompanyEmailById('msg-read')
    expect(result!.isUnread).toBe(false)
  })

  it('maps participants correctly via mapEmailRow', () => {
    testDb
      .prepare(`INSERT INTO email_messages (id, from_email, subject) VALUES (?, ?, ?)`)
      .run('msg-002', 'bob@example.com', 'Meeting invite')

    // from — has display_name
    testDb
      .prepare(
        `INSERT INTO email_message_participants (message_id, role, email, display_name, contact_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('msg-002', 'from', 'bob@example.com', 'Bob Smith', null)

    // to — has display_name and a contactId
    testDb
      .prepare(
        `INSERT INTO email_message_participants (message_id, role, email, display_name, contact_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('msg-002', 'to', 'carol@example.com', 'Carol', 'contact-carol')
    testDb.prepare(`INSERT INTO contacts (id, full_name) VALUES (?, ?)`).run('contact-carol', 'Carol Doe')

    // cc — empty display_name, no contact → displayName should be null
    testDb
      .prepare(
        `INSERT INTO email_message_participants (message_id, role, email, display_name, contact_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('msg-002', 'cc', 'dave@example.com', '', null)

    const result = getCompanyEmailById('msg-002')

    expect(result).not.toBeNull()
    expect(result!.participants).toHaveLength(3)

    // Participants are ordered: from(0) < to(1) < cc(2)
    const [fromP, toP, ccP] = result!.participants

    expect(fromP.role).toBe('from')
    expect(fromP.email).toBe('bob@example.com')
    expect(fromP.displayName).toBe('Bob Smith')
    expect(fromP.contactId).toBeNull()

    expect(toP.role).toBe('to')
    expect(toP.email).toBe('carol@example.com')
    expect(toP.displayName).toBe('Carol') // display_name takes precedence over full_name
    expect(toP.contactId).toBe('contact-carol')

    expect(ccP.role).toBe('cc')
    expect(ccP.email).toBe('dave@example.com')
    expect(ccP.displayName).toBeNull() // empty string → NULLIF → null, no contact fallback
    expect(ccP.contactId).toBeNull()
  })

  it('falls back to contact full_name when participant display_name is empty', () => {
    testDb
      .prepare(`INSERT INTO email_messages (id, from_email) VALUES (?, ?)`)
      .run('msg-003', 'sender@example.com')

    testDb.prepare(`INSERT INTO contacts (id, full_name) VALUES (?, ?)`).run('contact-eve', 'Eve Wilson')

    testDb
      .prepare(
        `INSERT INTO email_message_participants (message_id, role, email, display_name, contact_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('msg-003', 'to', 'eve@example.com', '', 'contact-eve')

    const result = getCompanyEmailById('msg-003')

    const toP = result!.participants.find((p) => p.role === 'to')
    expect(toP?.displayName).toBe('Eve Wilson') // fell back to contacts.full_name
    expect(toP?.contactId).toBe('contact-eve')
  })
})
