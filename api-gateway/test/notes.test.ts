import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// /notes list + detail tests.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-nt-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdCompanyIds: string[] = []
const createdContactIds: string[] = []
const createdMeetingIds: string[] = []
const createdNoteIds: string[] = []

afterAll(async () => {
  if (createdNoteIds.length > 0) {
    await db.delete(schema.notes).where(inArray(schema.notes.id, createdNoteIds))
  }
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdContactIds.length > 0) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
  }
  if (createdCompanyIds.length > 0) {
    await db
      .delete(schema.orgCompanies)
      .where(inArray(schema.orgCompanies.id, createdCompanyIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function insertUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
  })
  createdUserIds.push(id)
  return id
}

async function insertCompany(userId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    status: 'active',
  })
  createdCompanyIds.push(id)
  return id
}

async function insertContact(userId: string, fullName: string): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId,
    fullName,
    normalizedName: fullName.toLowerCase(),
  })
  createdContactIds.push(id)
  return id
}

async function insertMeeting(userId: string, title: string): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title,
    date: new Date(),
    durationSeconds: 1800,
    status: 'completed',
  })
  createdMeetingIds.push(id)
  return id
}

async function insertNote(opts: {
  userId: string
  title?: string
  content: string
  companyId?: string
  contactId?: string
  meetingId?: string
  isPinned?: boolean
  updatedAt?: Date
}): Promise<string> {
  const id = TEST_PREFIX + 'nt-' + createId().slice(0, 8)
  const now = opts.updatedAt ?? new Date()
  await db.insert(schema.notes).values({
    id,
    userId: opts.userId,
    title: opts.title ?? null,
    content: opts.content,
    companyId: opts.companyId ?? null,
    contactId: opts.contactId ?? null,
    sourceMeetingId: opts.meetingId ?? null,
    isPinned: opts.isPinned ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  })
  createdNoteIds.push(id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

describe('GET /notes', () => {
  test('sorted by pinned DESC then updatedAt DESC', async () => {
    const userId = await insertUser()

    const oldId = await insertNote({
      userId,
      content: 'Old note',
      updatedAt: new Date('2026-01-01T10:00:00Z'),
    })
    const recentId = await insertNote({
      userId,
      content: 'Recent note',
      updatedAt: new Date('2026-05-15T10:00:00Z'),
    })
    const pinnedId = await insertNote({
      userId,
      content: 'Pinned but old',
      isPinned: true,
      updatedAt: new Date('2026-01-15T10:00:00Z'),
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      notes: Array<{ id: string; isPinned: boolean }>
    }
    const ours = body.notes.filter((n) => createdNoteIds.includes(n.id))
    expect(ours.length).toBe(3)

    const positions = {
      pinned: ours.findIndex((n) => n.id === pinnedId),
      recent: ours.findIndex((n) => n.id === recentId),
      old: ours.findIndex((n) => n.id === oldId),
    }
    // Pinned first regardless of date.
    expect(positions.pinned).toBeLessThan(positions.recent)
    expect(positions.recent).toBeLessThan(positions.old)
    expect(ours.find((n) => n.id === pinnedId)?.isPinned).toBe(true)
  })

  test('joins company + contact names into list rows', async () => {
    const userId = await insertUser()
    const companyId = await insertCompany(userId, 'AcmeCo ' + TEST_PREFIX)
    const contactId = await insertContact(userId, 'Pat Person ' + TEST_PREFIX)

    const cId = await insertNote({
      userId,
      content: 'company note',
      companyId,
    })
    const ctId = await insertNote({
      userId,
      content: 'contact note',
      contactId,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as {
      notes: Array<{
        id: string
        companyName: string | null
        contactName: string | null
      }>
    }
    expect(body.notes.find((n) => n.id === cId)?.companyName).toBe(
      'AcmeCo ' + TEST_PREFIX,
    )
    expect(body.notes.find((n) => n.id === ctId)?.contactName).toBe(
      'Pat Person ' + TEST_PREFIX,
    )
  })

  test('?companyId filter restricts to that company only', async () => {
    const userId = await insertUser()
    const coA = await insertCompany(userId, 'A Co ' + TEST_PREFIX)
    const coB = await insertCompany(userId, 'B Co ' + TEST_PREFIX)

    const noteA = await insertNote({ userId, content: 'A', companyId: coA })
    await insertNote({ userId, content: 'B', companyId: coB })
    await insertNote({ userId, content: 'untagged' })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/notes?companyId=${coA}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as { notes: Array<{ id: string }> }
    const ourMatches = body.notes
      .filter((n) => createdNoteIds.includes(n.id))
      .map((n) => n.id)
    expect(ourMatches).toEqual([noteA])
  })

  test('?untagged=true returns only notes with no company or contact', async () => {
    const userId = await insertUser()
    const companyId = await insertCompany(userId, 'X Co ' + TEST_PREFIX)
    await insertNote({ userId, content: 'tagged', companyId })
    const untaggedId = await insertNote({ userId, content: 'lone-note ' + TEST_PREFIX })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?untagged=true&limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as { notes: Array<{ id: string }> }
    const ours = body.notes.filter((n) => createdNoteIds.includes(n.id))
    expect(ours.map((n) => n.id)).toEqual([untaggedId])
  })

  test('?q= matches via FTS on title + content', async () => {
    const userId = await insertUser()
    const hitId = await insertNote({
      userId,
      title: 'Cap table',
      content: 'Term sheet draft for Series A',
    })
    await insertNote({
      userId,
      title: 'Unrelated',
      content: 'something completely different',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?q=series',
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as { notes: Array<{ id: string }> }
    const ourMatches = body.notes
      .filter((n) => createdNoteIds.includes(n.id))
      .map((n) => n.id)
    expect(ourMatches).toEqual([hitId])
  })

  test('user isolation', async () => {
    const userA = await insertUser()
    const userB = await insertUser()
    const aNote = await insertNote({ userId: userA, content: 'A' })
    const bNote = await insertNote({ userId: userB, content: 'B' })

    const jwtA = await mintJwt(userA)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?limit=100',
      headers: { authorization: `Bearer ${jwtA}` },
    })

    const body = res.json() as { notes: Array<{ id: string }> }
    const ids = body.notes.map((n) => n.id)
    expect(ids).toContain(aNote)
    expect(ids).not.toContain(bNote)
  })

  test('contentPreview is single-line and truncated at 200 chars', async () => {
    const userId = await insertUser()
    const longContent = 'word '.repeat(60) + 'TAIL' // 304 chars with whitespace
    const longId = await insertNote({ userId, content: longContent })
    const multilineId = await insertNote({
      userId,
      content: 'line one\nline two\n\nline three',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes?limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as { notes: Array<{ id: string; contentPreview: string }> }
    const longPreview = body.notes.find((n) => n.id === longId)?.contentPreview
    expect(longPreview).toBeDefined()
    expect(longPreview!.length).toBeLessThanOrEqual(200)
    expect(longPreview!.endsWith('…')).toBe(true)

    const multiPreview = body.notes.find((n) => n.id === multilineId)?.contentPreview
    expect(multiPreview).toBe('line one line two line three')
  })

  test('401 with no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/notes' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /notes/:id', () => {
  test('returns content + joined entity names', async () => {
    const userId = await insertUser()
    const companyId = await insertCompany(userId, 'DetailCo ' + TEST_PREFIX)
    const contactId = await insertContact(userId, 'Detail Person ' + TEST_PREFIX)
    const meetingId = await insertMeeting(userId, 'Source Call ' + TEST_PREFIX)

    const noteId = await insertNote({
      userId,
      title: 'Roadmap notes',
      content: 'Quarterly priorities and ARR targets.',
      companyId,
      contactId,
      meetingId,
      isPinned: true,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      title: string | null
      content: string
      isPinned: boolean
      companyName: string | null
      contactName: string | null
      sourceMeetingTitle: string | null
    }

    expect(body.id).toBe(noteId)
    expect(body.title).toBe('Roadmap notes')
    expect(body.content).toBe('Quarterly priorities and ARR targets.')
    expect(body.isPinned).toBe(true)
    expect(body.companyName).toBe('DetailCo ' + TEST_PREFIX)
    expect(body.contactName).toBe('Detail Person ' + TEST_PREFIX)
    expect(body.sourceMeetingTitle).toBe('Source Call ' + TEST_PREFIX)
  })

  test('404 when note belongs to a different user', async () => {
    const owner = await insertUser()
    const intruder = await insertUser()
    const noteId = await insertNote({ userId: owner, content: 'secret' })

    const jwt = await mintJwt(intruder)
    const res = await app.inject({
      method: 'GET',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'NOTE_NOT_FOUND' } })
  })

  test('404 for non-existent id', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/notes/does-not-exist',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
