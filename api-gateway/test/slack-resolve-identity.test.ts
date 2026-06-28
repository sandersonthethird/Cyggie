// Slice D (8A + 12A) — direct unit tests for resolveSlackIdentity, the single
// source of the Slack cross-firm leak guard. Mapped/unmapped are driven via the
// slack_user_mappings cache (no Slack API); transient is driven via a mocked
// users.info that rate-limits. The key property: in a NON-beta workspace,
// anything that isn't a confirmed mapping → refuse (never the default user).
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

// users.info only fires on a cache MISS. The mapped/unmapped cases seed the
// cache, so they never hit this; the transient case (no cache row) does.
const usersInfoMock = vi.fn()
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({ users: { info: usersInfoMock } })),
}))

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { resolveSlackIdentity } = await import('../src/slack/user-mapping')

const baseEnv = loadEnv()
const db = getDb(baseEnv.GATEWAY_DATABASE_URL)
const cleanup = makeDbCleanup(db)
const P = `test-rsi-${Date.now().toString(36)}-`

const BETA_WS = P + 'beta-ws'
const OTHER_WS = P + 'other-ws'
const DEFAULT_USER = P + 'default-user'
const MAPPED_USER = P + 'mapped-user'
const FIRM_ID = P + 'firm'

const env = {
  ...baseEnv,
  BETA_SLACK_WORKSPACE_ID: BETA_WS,
  CYGGIE_SLACK_DEFAULT_USER_ID: DEFAULT_USER,
  SLACK_BOT_TOKEN: 'xoxb-test-resolve-identity',
}

async function mkUser(id: string, firmId: string | null): Promise<void> {
  await db
    .insert(schema.users)
    .values({ id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: id, firmId })
  cleanup.track(schema.users, schema.users.id, id)
}

async function seedMapping(ws: string, slackUser: string, cyggieUserId: string | null): Promise<void> {
  const id = createId()
  await db.insert(schema.slackUserMappings).values({
    id,
    slackWorkspaceId: ws,
    slackUserId: slackUser,
    cyggieUserId,
    slackEmail: cyggieUserId ? `${cyggieUserId}@example.com` : 'nobody@example.com',
  })
  cleanup.track(schema.slackUserMappings, schema.slackUserMappings.id, id)
}

beforeAll(async () => {
  await db.insert(schema.firms).values({ id: FIRM_ID, name: 'RSI Test Firm', slug: P + 'firm-slug' })
  cleanup.track(schema.firms, schema.firms.id, FIRM_ID)
  await mkUser(MAPPED_USER, FIRM_ID)
  await mkUser(DEFAULT_USER, FIRM_ID)
  // Cache: a mapped user (any workspace) and an unmapped user in each workspace.
  await seedMapping(OTHER_WS, 'SU_mapped', MAPPED_USER)
  await seedMapping(BETA_WS, 'SU_unmapped', null)
  await seedMapping(OTHER_WS, 'SU_unmapped', null)
})

afterAll(async () => {
  // Break the users↔firms FK before the firm delete.
  await cleanup.cleanup()
})

describe('resolveSlackIdentity (Slice D fail-closed)', () => {
  test('mapped → resolved with the mapped user + their firm', async () => {
    const r = await resolveSlackIdentity({
      db,
      env,
      workspaceId: OTHER_WS,
      slackUserId: 'SU_mapped',
    })
    expect(r).toEqual({ kind: 'resolved', userId: MAPPED_USER, firmId: FIRM_ID, mapped: true })
  })

  test('unmapped + BETA workspace → default user (mapped:false)', async () => {
    const r = await resolveSlackIdentity({
      db,
      env,
      workspaceId: BETA_WS,
      slackUserId: 'SU_unmapped',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.userId).toBe(DEFAULT_USER)
      expect(r.mapped).toBe(false)
    }
  })

  test('unmapped + NON-beta workspace → refuse (no cross-firm leak)', async () => {
    const r = await resolveSlackIdentity({
      db,
      env,
      workspaceId: OTHER_WS,
      slackUserId: 'SU_unmapped',
    })
    expect(r).toEqual({ kind: 'refuse', reason: 'unmapped' })
  })

  test('transient Slack failure + NON-beta workspace → refuse (fail closed)', async () => {
    // No cache row for this slack user → users.info is called → rate-limited
    // twice → resolveSlackUser returns transient_failure → non-beta → refuse.
    usersInfoMock.mockRejectedValue({ data: { error: 'ratelimited' } })
    const r = await resolveSlackIdentity({
      db,
      env,
      workspaceId: OTHER_WS,
      slackUserId: 'SU_transient_' + createId().slice(0, 6),
    })
    expect(r).toEqual({ kind: 'refuse', reason: 'transient' })
  })
})
