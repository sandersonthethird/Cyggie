import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './db-cleanup'

// Issue 8A: the cleanup helper's failure mode is *silent* — a wrong FK-delete
// order leaves orphaned rows that pollute later suites as intermittent flake
// (the cb27962 class). So exercise it directly against the local PG: seed a
// full FK chain user→company→contact→meeting→note, track in insert order, run
// cleanup, and assert every row is gone with no FK violation thrown.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

const { loadEnv } = await import('../../src/env')
const { getDb } = await import('../../src/db')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const PREFIX = `test-cleanup-${Date.now().toString(36)}-`

// Belt-and-suspenders: if an assertion below throws before cleanup runs, this
// still removes the seeded rows so the helper's own test never pollutes others.
const fallback = makeDbCleanup(db)
afterAll(() => fallback.cleanup())

describe('makeDbCleanup', () => {
  test('deletes a full FK chain child→parent with no violation, leaving nothing', async () => {
    const cleanup = makeDbCleanup(db)

    // Seed parent→child (the only order FKs allow), tracking each row.
    const userId = cleanup.track(schema.users, schema.users.id, PREFIX + createId().slice(0, 8))
    fallback.track(schema.users, schema.users.id, userId)
    await db.insert(schema.users).values({
      id: userId,
      googleSub: 'sub-' + userId,
      email: `${userId}@example.com`,
      displayName: userId,
    })

    const companyId = cleanup.track(schema.orgCompanies, schema.orgCompanies.id, PREFIX + 'co-' + createId().slice(0, 8))
    fallback.track(schema.orgCompanies, schema.orgCompanies.id, companyId)
    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'Cleanup Co',
      normalizedName: 'cleanup co ' + companyId,
      status: 'active',
    })

    const contactId = cleanup.track(schema.contacts, schema.contacts.id, PREFIX + 'ct-' + createId().slice(0, 8))
    fallback.track(schema.contacts, schema.contacts.id, contactId)
    await db.insert(schema.contacts).values({
      id: contactId,
      userId,
      fullName: 'Cleanup Contact',
      normalizedName: 'cleanup contact ' + contactId,
      primaryCompanyId: companyId,
    })

    const meetingId = cleanup.track(schema.meetings, schema.meetings.id, PREFIX + 'mtg-' + createId().slice(0, 8))
    fallback.track(schema.meetings, schema.meetings.id, meetingId)
    await db.insert(schema.meetings).values({
      id: meetingId,
      userId,
      title: 'Cleanup Meeting',
      date: new Date(),
      durationSeconds: 1800,
      status: 'completed',
    })

    const noteId = cleanup.track(schema.notes, schema.notes.id, PREFIX + 'nt-' + createId().slice(0, 8))
    fallback.track(schema.notes, schema.notes.id, noteId)
    await db.insert(schema.notes).values({
      id: noteId,
      userId,
      title: 'Cleanup Note',
      content: 'body',
      companyId,
      contactId,
      sourceMeetingId: meetingId,
      isPinned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // The note FK-references company/contact/meeting/user. If cleanup deleted
    // the user first this would throw a FK violation — so a clean resolve here
    // is the order assertion.
    await expect(cleanup.cleanup()).resolves.toBeUndefined()

    // Every seeded row is gone.
    for (const [table, col, id] of [
      [schema.notes, schema.notes.id, noteId],
      [schema.meetings, schema.meetings.id, meetingId],
      [schema.contacts, schema.contacts.id, contactId],
      [schema.orgCompanies, schema.orgCompanies.id, companyId],
      [schema.users, schema.users.id, userId],
    ] as const) {
      const rows = await db.select().from(table).where(inArray(col, [id]))
      expect(rows.length).toBe(0)
    }
  })

  test('cleanup is idempotent — a second call is a no-op', async () => {
    const cleanup = makeDbCleanup(db)
    const userId = cleanup.track(schema.users, schema.users.id, PREFIX + 'idem-' + createId().slice(0, 8))
    fallback.track(schema.users, schema.users.id, userId)
    await db.insert(schema.users).values({
      id: userId,
      googleSub: 'sub-' + userId,
      email: `${userId}@example.com`,
      displayName: userId,
    })
    await cleanup.cleanup()
    await expect(cleanup.cleanup()).resolves.toBeUndefined()
  })
})
