import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Phase 3 (Mobile Chat) — gateway coverage for the flagged-files section
// of buildSelectedCompaniesContext. The desktop extraction worker fills
// `extracted_text` + sets `extraction_status='done'`; the gateway picks
// it up and renders a "Flagged documents" sub-section per selected
// company. Other extraction states must NOT leak through.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { buildSelectedCompaniesContext } = await import('../src/routes/chat')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-chat-flagfile-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, jwt }
}

async function insertCompany(userId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: name,
    normalizedName: name.toLowerCase().replace(/\s+/g, ' ').trim(),
    status: 'active',
    entityType: 'unknown',
    classificationSource: 'manual',
    lamport: '1',
    createdByUserId: userId,
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function insertFlaggedFile(opts: {
  userId: string
  companyId: string
  fileName: string
  extractionStatus: 'pending' | 'extracting' | 'done' | 'failed'
  extractedText?: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'flag-' + createId().slice(0, 8)
  await db.insert(schema.companyFlaggedFiles).values({
    id,
    userId: opts.userId,
    companyId: opts.companyId,
    fileId: `file-${createId().slice(0, 8)}`,
    fileName: opts.fileName,
    flaggedAt: new Date(),
    extractionStatus: opts.extractionStatus,
    extractedText: opts.extractedText ?? null,
    extractedTextChars: opts.extractedText?.length ?? null,
    lamport: '1',
  })
  cleanup.track(schema.companyFlaggedFiles, schema.companyFlaggedFiles.id, id)
  return id
}

// ──────────────────────────────────────────────────────────────────────────
// buildSelectedCompaniesContext — flagged-files section
// ──────────────────────────────────────────────────────────────────────────

describe('buildSelectedCompaniesContext — flagged documents', () => {
  test('1. company with two done-status flagged files → both rendered with ### filename headers', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'TwoFiles Co')
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'pitch-deck.pdf',
      extractionStatus: 'done',
      extractedText: 'Pitch deck contents — slide 1 says hello.',
    })
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'financials.xlsx',
      extractionStatus: 'done',
      extractedText: 'Sheet: ARR — Q1: $1M, Q2: $1.4M',
    })

    const output = await buildSelectedCompaniesContext(db, [cid], userId)
    expect(output).toContain('Flagged documents:')
    expect(output).toContain('### pitch-deck.pdf')
    expect(output).toContain('Pitch deck contents — slide 1')
    expect(output).toContain('### financials.xlsx')
    expect(output).toContain('Sheet: ARR — Q1: $1M')
  })

  test('2. status=pending flagged file → NOT in context (filtered)', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'Pending Co')
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'wip.pdf',
      extractionStatus: 'pending',
      extractedText: null,
    })

    const output = await buildSelectedCompaniesContext(db, [cid], userId)
    // No flagged-documents section — and the filename never appears.
    expect(output ?? '').not.toContain('Flagged documents:')
    expect(output ?? '').not.toContain('wip.pdf')
  })

  test('3. status=failed flagged file → NOT in context', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'Failed Co')
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'corrupt.pdf',
      extractionStatus: 'failed',
      extractedText: null,
    })

    const output = await buildSelectedCompaniesContext(db, [cid], userId)
    expect(output ?? '').not.toContain('Flagged documents:')
    expect(output ?? '').not.toContain('corrupt.pdf')
  })

  test('4. status=done but extracted_text=NULL → filtered out (defensive)', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'Empty Co')
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'somehow-blank.pdf',
      extractionStatus: 'done',
      extractedText: null,
    })

    const output = await buildSelectedCompaniesContext(db, [cid], userId)
    expect(output ?? '').not.toContain('somehow-blank.pdf')
  })

  test('5. flagged file longer than 8K cap → truncated with marker', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'Long Co')
    const longText = 'A'.repeat(20_000)
    await insertFlaggedFile({
      userId,
      companyId: cid,
      fileName: 'huge.pdf',
      extractionStatus: 'done',
      extractedText: longText,
    })

    const output = await buildSelectedCompaniesContext(db, [cid], userId)
    expect(output).toContain('### huge.pdf')
    expect(output).toContain('[...truncated...]')
    // The file section is bounded — the truncated body itself is ~8K + the
    // marker; the whole company block adds COMPANY: header etc.
    const fileMatch = output!.match(/### huge\.pdf\n([\s\S]+?)(?=\n\n|$)/)
    expect(fileMatch).not.toBeNull()
    expect(fileMatch![1]!.length).toBeLessThan(10_000)
  })

  test('6. cross-user isolation — User A\'s flagged file does NOT appear in User B\'s context', async () => {
    const { userId: userA } = await setupUser()
    const { userId: userB } = await setupUser()
    // A and B have their own companies (normalized_name is globally
    // unique so we use distinct names). A flags a file on A's company.
    const cidA = await insertCompany(userA, `User A Co ${createId().slice(0, 4)}`)
    const cidB = await insertCompany(userB, `User B Co ${createId().slice(0, 4)}`)
    await insertFlaggedFile({
      userId: userA,
      companyId: cidA,
      fileName: 'a-only.pdf',
      extractionStatus: 'done',
      extractedText: 'A-private contents',
    })

    // Build context as User B against B's company id — A's flagged file
    // must NOT bleed through.
    const outputB = await buildSelectedCompaniesContext(db, [cidB], userB)
    expect(outputB ?? '').not.toContain('a-only.pdf')
    expect(outputB ?? '').not.toContain('A-private contents')

    // Sanity: A still sees their own file in their own context.
    const outputA = await buildSelectedCompaniesContext(db, [cidA], userA)
    expect(outputA).toContain('a-only.pdf')
  })

  test('7. selecting 3 companies, only one has flagged files → only that company\'s block has the section', async () => {
    const { userId } = await setupUser()
    const cidWith = await insertCompany(userId, 'Has Files')
    const cidWithoutA = await insertCompany(userId, 'No Files A')
    const cidWithoutB = await insertCompany(userId, 'No Files B')
    await insertFlaggedFile({
      userId,
      companyId: cidWith,
      fileName: 'memo.pdf',
      extractionStatus: 'done',
      extractedText: 'Important memo body.',
    })

    const output = await buildSelectedCompaniesContext(
      db,
      [cidWith, cidWithoutA, cidWithoutB],
      userId,
    )
    expect(output).toContain('COMPANY: Has Files')
    expect(output).toContain('COMPANY: No Files A')
    expect(output).toContain('COMPANY: No Files B')
    // Only one Flagged documents section in the entire output.
    const matches = output!.match(/Flagged documents:/g) ?? []
    expect(matches).toHaveLength(1)
    // And its filename only appears once.
    expect(output).toContain('### memo.pdf')
  })
})
