import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Load .env.local once. The tests hit the actual Neon DB used by dev —
// production usage on Fly is shielded because we tag rows with a clear
// `test-` ID prefix and clean them up in afterAll.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

// Force NODE_ENV=test BEFORE importing the app so logger is silent and
// _debug routes mount.
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

// Test IDs get prefixed so afterAll can wipe them deterministically.
const TEST_PREFIX = `test-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdFirmIds: string[] = []
const createdInviteIds: string[] = []

afterAll(async () => {
  // Order matters: invites → users (firm_id nulled) → firms.
  if (createdInviteIds.length > 0) {
    await db.delete(schema.invites).where(inArray(schema.invites.id, createdInviteIds))
  }
  if (createdUserIds.length > 0) {
    // Unset firm_id first so the firm delete cascade doesn't fight users FK.
    await db
      .update(schema.users)
      .set({ firmId: null, invitedByUserId: null })
      .where(inArray(schema.users.id, createdUserIds))
    await db.delete(schema.sessions).where(inArray(schema.sessions.userId, createdUserIds))
    await db
      .delete(schema.oauthTokens)
      .where(inArray(schema.oauthTokens.userId, createdUserIds))
    await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, createdUserIds))
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  if (createdFirmIds.length > 0) {
    await db.delete(schema.firms).where(inArray(schema.firms.id, createdFirmIds))
  }
  await app.close()
})

async function insertTestUser(opts: { email: string }): Promise<string> {
  // Keep IDs short — google_sub is varchar(64), so anything we derive from
  // the user id has to fit comfortably under that cap.
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id, // ~26 chars, well under 64
    email: opts.email,
    displayName: opts.email,
  })
  createdUserIds.push(id)
  return id
}

async function mintJwt(opts: {
  userId: string
  firmId: string | null
  role: 'admin' | 'member'
}): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: opts.userId,
    sid: TEST_PREFIX + 'session-' + opts.userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: opts.firmId,
    role: opts.role,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow A — create workspace as the first user from a firm.
// ─────────────────────────────────────────────────────────────────────────────
describe('multi-tenant onboarding', () => {
  test('Flow A: claim workspace, becomes admin, JWT carries firm_id', async () => {
    const aliceEmail = `alice-${TEST_PREFIX}@example.com`
    const aliceId = await insertTestUser({ email: aliceEmail })
    const aliceJwt = await mintJwt({ userId: aliceId, firmId: null, role: 'member' })

    const slug = (TEST_PREFIX + 'redswan').replace(/_/g, '-').toLowerCase()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${aliceJwt}`, 'content-type': 'application/json' },
      payload: { name: 'Red Swan Ventures (test)', slug },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      access_token: string
      firm: { id: string; name: string; slug: string; plan: string }
    }
    expect(body.firm.name).toBe('Red Swan Ventures (test)')
    expect(body.firm.slug).toBe(slug)
    expect(body.firm.plan).toBe('trial')
    createdFirmIds.push(body.firm.id)

    // User row updated with firm_id + admin role.
    const userRow = await db.query.users.findFirst({
      where: eq(schema.users.id, aliceId),
    })
    expect(userRow?.firmId).toBe(body.firm.id)
    expect(userRow?.role).toBe('admin')

    // New JWT carries firm_id — decode without verifying just to inspect.
    const [, payloadB64] = body.access_token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString())
    expect(payload.firm_id).toBe(body.firm.id)
    expect(payload.role).toBe('admin')
    expect(payload.sub).toBe(aliceId)
  })

  test('Flow A: slug collision returns 409', async () => {
    const bobEmail = `bob-${TEST_PREFIX}@example.com`
    const bobId = await insertTestUser({ email: bobEmail })
    const bobJwt = await mintJwt({ userId: bobId, firmId: null, role: 'member' })

    // First claim — succeeds.
    const slug = (TEST_PREFIX + 'duplicate').replace(/_/g, '-').toLowerCase()
    const first = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${bobJwt}`, 'content-type': 'application/json' },
      payload: { name: 'Test Firm A', slug },
    })
    expect(first.statusCode).toBe(200)
    createdFirmIds.push((first.json() as { firm: { id: string } }).firm.id)

    // Second claim with same slug, different user — must 409.
    const carolEmail = `carol-${TEST_PREFIX}@example.com`
    const carolId = await insertTestUser({ email: carolEmail })
    const carolJwt = await mintJwt({ userId: carolId, firmId: null, role: 'member' })
    const second = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${carolJwt}`, 'content-type': 'application/json' },
      payload: { name: 'Test Firm A2', slug },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'SLUG_TAKEN' } })
  })

  test('Flow A: caller already in a firm returns 409', async () => {
    // Spin up a fresh firm for danielle so she is an admin somewhere.
    const danielleEmail = `danielle-${TEST_PREFIX}@example.com`
    const danielleId = await insertTestUser({ email: danielleEmail })
    const setupJwt = await mintJwt({ userId: danielleId, firmId: null, role: 'member' })
    const firstSlug = (TEST_PREFIX + 'existing').replace(/_/g, '-').toLowerCase()
    const first = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${setupJwt}`, 'content-type': 'application/json' },
      payload: { name: 'Existing Firm', slug: firstSlug },
    })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json() as { firm: { id: string } }
    createdFirmIds.push(firstBody.firm.id)

    // Now her JWT should carry firm_id — try to claim a second one.
    const refreshedJwt = await mintJwt({
      userId: danielleId,
      firmId: firstBody.firm.id,
      role: 'admin',
    })
    const second = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${refreshedJwt}`, 'content-type': 'application/json' },
      payload: {
        name: 'Second Firm',
        slug: (TEST_PREFIX + 'second').replace(/_/g, '-').toLowerCase(),
      },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'ALREADY_IN_FIRM' } })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Flow B — invite generation + acceptance.
  // ───────────────────────────────────────────────────────────────────────────
  test('Flow B: admin issues invite, partner accepts, becomes member', async () => {
    // Set up the firm with eve as admin.
    const eveEmail = `eve-${TEST_PREFIX}@example.com`
    const eveId = await insertTestUser({ email: eveEmail })
    const setupJwt = await mintJwt({ userId: eveId, firmId: null, role: 'member' })
    const slug = (TEST_PREFIX + 'invite-test').replace(/_/g, '-').toLowerCase()
    const claim = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${setupJwt}`, 'content-type': 'application/json' },
      payload: { name: 'Invite Test Firm', slug },
    })
    expect(claim.statusCode).toBe(200)
    const firmId = (claim.json() as { firm: { id: string } }).firm.id
    createdFirmIds.push(firmId)
    const eveAdminJwt = await mintJwt({ userId: eveId, firmId, role: 'admin' })

    // Admin generates an invite for frank.
    const frankEmail = `frank-${TEST_PREFIX}@example.com`
    const issued = await app.inject({
      method: 'POST',
      url: '/firms/me/invites',
      headers: {
        authorization: `Bearer ${eveAdminJwt}`,
        'content-type': 'application/json',
      },
      payload: { email: frankEmail },
    })
    expect(issued.statusCode).toBe(200)
    const inviteBody = issued.json() as {
      id: string
      email: string
      token: string
      expires_at: string
      deep_link: string
    }
    createdInviteIds.push(inviteBody.id)
    expect(inviteBody.email).toBe(frankEmail.toLowerCase())
    expect(inviteBody.token.length).toBeGreaterThan(20)
    expect(inviteBody.deep_link).toBe(`cyggie://invite/${inviteBody.token}`)

    // Frank OAuths in, JWT carries firm_id=null, joins via the token.
    const frankId = await insertTestUser({ email: frankEmail })
    const frankJwt = await mintJwt({ userId: frankId, firmId: null, role: 'member' })
    const join = await app.inject({
      method: 'POST',
      url: '/auth/firms/join',
      headers: { authorization: `Bearer ${frankJwt}`, 'content-type': 'application/json' },
      payload: { token: inviteBody.token },
    })
    expect(join.statusCode).toBe(200)
    const joinBody = join.json() as { access_token: string; firm: { id: string } }
    expect(joinBody.firm.id).toBe(firmId)

    // Frank's user row now has firm_id + invited_by + member role.
    const frankRow = await db.query.users.findFirst({
      where: eq(schema.users.id, frankId),
    })
    expect(frankRow?.firmId).toBe(firmId)
    expect(frankRow?.role).toBe('member')
    expect(frankRow?.invitedByUserId).toBe(eveId)

    // Invite row is marked accepted.
    const inviteRow = await db.query.invites.findFirst({
      where: eq(schema.invites.id, inviteBody.id),
    })
    expect(inviteRow?.acceptedAt).not.toBeNull()
    expect(inviteRow?.acceptedByUserId).toBe(frankId)

    // Second join attempt with the same token fails.
    const replayJwt = await mintJwt({ userId: frankId, firmId, role: 'member' })
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/firms/join',
      headers: { authorization: `Bearer ${replayJwt}`, 'content-type': 'application/json' },
      payload: { token: inviteBody.token },
    })
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({ error: { code: 'ALREADY_IN_FIRM' } })
  })

  test('Flow B: token issued to a different email is rejected', async () => {
    // Admin gina creates firm + invite for henry@example.com.
    const ginaEmail = `gina-${TEST_PREFIX}@example.com`
    const ginaId = await insertTestUser({ email: ginaEmail })
    const setupJwt = await mintJwt({ userId: ginaId, firmId: null, role: 'member' })
    const claim = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${setupJwt}`, 'content-type': 'application/json' },
      payload: {
        name: 'Email Mismatch Test',
        slug: (TEST_PREFIX + 'mismatch').replace(/_/g, '-').toLowerCase(),
      },
    })
    expect(claim.statusCode).toBe(200)
    const firmId = (claim.json() as { firm: { id: string } }).firm.id
    createdFirmIds.push(firmId)
    const ginaAdminJwt = await mintJwt({ userId: ginaId, firmId, role: 'admin' })

    const henryEmail = `henry-${TEST_PREFIX}@example.com`
    const issue = await app.inject({
      method: 'POST',
      url: '/firms/me/invites',
      headers: {
        authorization: `Bearer ${ginaAdminJwt}`,
        'content-type': 'application/json',
      },
      payload: { email: henryEmail },
    })
    expect(issue.statusCode).toBe(200)
    const inviteBody = issue.json() as { id: string; token: string }
    createdInviteIds.push(inviteBody.id)

    // Imogen — a completely different account — tries to redeem it.
    const imogenEmail = `imogen-${TEST_PREFIX}@example.com`
    const imogenId = await insertTestUser({ email: imogenEmail })
    const imogenJwt = await mintJwt({ userId: imogenId, firmId: null, role: 'member' })
    const reject = await app.inject({
      method: 'POST',
      url: '/auth/firms/join',
      headers: { authorization: `Bearer ${imogenJwt}`, 'content-type': 'application/json' },
      payload: { token: inviteBody.token },
    })
    expect(reject.statusCode).toBe(403)
    expect(reject.json()).toMatchObject({ error: { code: 'INVITE_EMAIL_MISMATCH' } })
  })

  test('GET /firms/me returns 403 NO_FIRM when JWT has no firm_id', async () => {
    const orphanEmail = `orphan-${TEST_PREFIX}@example.com`
    const orphanId = await insertTestUser({ email: orphanEmail })
    const orphanJwt = await mintJwt({ userId: orphanId, firmId: null, role: 'member' })
    const res = await app.inject({
      method: 'GET',
      url: '/firms/me',
      headers: { authorization: `Bearer ${orphanJwt}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: { code: 'NO_FIRM' } })
  })

  test('admin-only routes 403 for non-admin members', async () => {
    // Set up firm + add jules as member.
    const adminEmail = `adminuser-${TEST_PREFIX}@example.com`
    const adminId = await insertTestUser({ email: adminEmail })
    const setupJwt = await mintJwt({ userId: adminId, firmId: null, role: 'member' })
    const claim = await app.inject({
      method: 'POST',
      url: '/auth/firms/claim',
      headers: { authorization: `Bearer ${setupJwt}`, 'content-type': 'application/json' },
      payload: {
        name: 'Admin Gate Test',
        slug: (TEST_PREFIX + 'admin-gate').replace(/_/g, '-').toLowerCase(),
      },
    })
    expect(claim.statusCode).toBe(200)
    const firmId = (claim.json() as { firm: { id: string } }).firm.id
    createdFirmIds.push(firmId)

    const julesEmail = `jules-${TEST_PREFIX}@example.com`
    const julesId = await insertTestUser({ email: julesEmail })
    await db
      .update(schema.users)
      .set({ firmId, role: 'member' })
      .where(eq(schema.users.id, julesId))
    const julesJwt = await mintJwt({ userId: julesId, firmId, role: 'member' })

    // Jules can list members (any-member route).
    const list = await app.inject({
      method: 'GET',
      url: '/firms/me/members',
      headers: { authorization: `Bearer ${julesJwt}` },
    })
    expect(list.statusCode).toBe(200)

    // Jules cannot issue invites (admin-only).
    const issue = await app.inject({
      method: 'POST',
      url: '/firms/me/invites',
      headers: { authorization: `Bearer ${julesJwt}`, 'content-type': 'application/json' },
      payload: { email: `nobody-${TEST_PREFIX}@example.com` },
    })
    expect(issue.statusCode).toBe(403)
    expect(issue.json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
  })
})
