import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Phase 2 multiplayer: tasks is firm-shared with field-level LWW (same model as
// org_companies). Validates that (1) a teammate's /sync/pull receives a task
// another member pushed (firm-scope), and (2) concurrent edits to DIFFERENT
// fields of the same task both survive the gateway merge, while a same-field
// race resolves by lamport.

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

const TEST_PREFIX = `test-taskshare-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const firmId = TEST_PREFIX + 'firm'
let userA = ''
let userB = ''

async function setupFirm(): Promise<void> {
  await db.insert(schema.firms).values({
    id: firmId,
    name: 'Red Swan',
    slug: TEST_PREFIX + 'redswan',
  })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const label of ['A', 'B']) {
    const id = TEST_PREFIX + label
    await db.insert(schema.users).values({
      id,
      googleSub: 'sub-' + id,
      email: `${id}@example.com`,
      displayName: 'User ' + label,
      firmId,
    })
    cleanup.track(schema.users, schema.users.id, id)
    if (label === 'A') userA = id
    else userB = id
  }
}

function jwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device-' + userId,
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

function baseTask(id: string, userId: string, lamport: string): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    title: 'Follow up with Acme',
    status: 'open',
    category: 'action_item',
    source: 'manual',
    created_by_user_id: userId,
    updated_by_user_id: userId,
    lamport,
  }
}

let outboxCounter = 0

async function push(
  token: string,
  entry: { table: string; op: string; rowId: string; payload: Record<string, unknown>; lamport: string },
): Promise<{ acked: number[]; rejected: unknown[]; conflicts: unknown[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: TEST_PREFIX + 'dev', batch: [{ outboxId: ++outboxCounter, ...entry }] },
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('firm-shared tasks + field-LWW', () => {
  test('teammate pulls a pushed task; concurrent diff-field edits both survive', async () => {
    await setupFirm()
    const tokenA = await jwt(userA)
    const tokenB = await jwt(userB)
    const taskId = TEST_PREFIX + 'task1'
    cleanup.track(schema.tasks, schema.tasks.id, taskId)

    // 1. A inserts the task.
    const ins = await push(tokenA, {
      table: 'tasks',
      op: 'insert',
      rowId: taskId,
      payload: baseTask(taskId, userA, '100'),
      lamport: '100',
    })
    expect(ins.acked).toHaveLength(1)
    expect(ins.rejected).toHaveLength(0)

    // Gateway stamped firm_id from A's JWT.
    const stamped = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
    })
    expect(stamped?.firmId).toBe(firmId)

    // 2. B (same firm) pulls and receives A's task (firm-scope).
    const pullB = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=0',
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(pullB.statusCode).toBe(200)
    const pulled = pullB.json().tasks as Array<{ id: string }>
    expect(pulled.some((t) => t.id === taskId)).toBe(true)

    // 3. Concurrent edits to DIFFERENT fields: A sets description (@200), B sets
    //    priority (@201). Each field_lamports map names only the column changed.
    await push(tokenA, {
      table: 'tasks',
      op: 'update',
      rowId: taskId,
      payload: {
        ...baseTask(taskId, userA, '200'),
        description: 'A added detail',
        field_lamports: { description: '200' },
      },
      lamport: '200',
    })
    await push(tokenB, {
      table: 'tasks',
      op: 'update',
      rowId: taskId,
      payload: {
        ...baseTask(taskId, userB, '201'),
        priority: 'high',
        field_lamports: { priority: '201' },
      },
      lamport: '201',
    })

    const merged = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
    })
    // Both edits survived — field-LWW didn't clobber.
    expect(merged?.description).toBe('A added detail')
    expect(merged?.priority).toBe('high')

    // 4. Same-field race: A @300 vs B @299 on status; higher lamport wins.
    await push(tokenB, {
      table: 'tasks',
      op: 'update',
      rowId: taskId,
      payload: {
        ...baseTask(taskId, userB, '299'),
        status: 'dismissed',
        field_lamports: { status: '299' },
      },
      lamport: '299',
    })
    await push(tokenA, {
      table: 'tasks',
      op: 'update',
      rowId: taskId,
      payload: {
        ...baseTask(taskId, userA, '300'),
        status: 'done',
        field_lamports: { status: '300' },
      },
      lamport: '300',
    })
    const final = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
    })
    expect(final?.status).toBe('done')
    expect(final?.priority).toBe('high') // untouched, still B's
  })

  test('SECURITY: a cross-firm task push is rejected on firm_id mismatch', async () => {
    const tokenA = await jwt(userA)
    const taskId = TEST_PREFIX + 'task-sec'
    cleanup.track(schema.tasks, schema.tasks.id, taskId)

    // Payload claims a different firm_id than the JWT — must be rejected.
    const res = await push(tokenA, {
      table: 'tasks',
      op: 'insert',
      rowId: taskId,
      payload: { ...baseTask(taskId, userA, '100'), firm_id: 'some-other-firm' },
      lamport: '100',
    })
    expect(res.acked).toHaveLength(0)
    expect(res.rejected).toHaveLength(1)
  })
})
