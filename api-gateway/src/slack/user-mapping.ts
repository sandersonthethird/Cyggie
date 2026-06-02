// Lazy Slack → Cyggie user mapping (External Agents V1 slice 7).
//
// Per plan Q7: mapping is best-effort enrichment, not gating. A Slack
// user without a matching Cyggie account still gets bot answers; their
// audit rows just have on_behalf_of_user_id = NULL.
//
// Lookup flow:
//   1. SELECT from slack_user_mappings (cache hit → return cached id).
//   2. Cache miss → call Slack users.info (requires users:read.email).
//   3. Look up the returned email in Cyggie's users table.
//   4. Insert mapping row (cyggie_user_id may be NULL if no match).
//   5. Return resolved id (or null).
//
// Error handling (per plan slice 7 acceptance criteria):
//   429 → retry once with backoff. Second failure: don't cache, return
//         null for this call only.
//   401 → Sentry alert with tag `slack_token_revoked`; surface a
//         distinct "bot token revoked" failure to the caller.
//   404 → cache as unmapped (stable state).

import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import type { FastifyBaseLogger } from 'fastify'
import type { getDb } from '../db'
import { Sentry } from '../sentry'
import type { SlackClient } from './client'
import { WebClient } from '@slack/web-api'

export interface ResolveSlackUserArgs {
  db: ReturnType<typeof getDb>
  workspaceId: string
  slackUserId: string
  slackBotToken: string
  log?: FastifyBaseLogger
}

export type ResolveSlackUserResult =
  | { kind: 'mapped'; cyggieUserId: string; email: string }
  | { kind: 'unmapped'; email: string | null }
  | { kind: 'transient_failure' } // 429 / network blip; don't cache
  | { kind: 'bot_token_revoked' }

export async function resolveSlackUser(
  args: ResolveSlackUserArgs,
): Promise<ResolveSlackUserResult> {
  const { db, workspaceId, slackUserId, slackBotToken, log } = args

  // 1. Cache hit?
  const cached = await db
    .select({
      cyggieUserId: schema.slackUserMappings.cyggieUserId,
      slackEmail: schema.slackUserMappings.slackEmail,
    })
    .from(schema.slackUserMappings)
    .where(
      and(
        eq(schema.slackUserMappings.slackWorkspaceId, workspaceId),
        eq(schema.slackUserMappings.slackUserId, slackUserId),
      ),
    )
    .limit(1)
  if (cached[0]) {
    return cached[0].cyggieUserId
      ? {
          kind: 'mapped',
          cyggieUserId: cached[0].cyggieUserId,
          email: cached[0].slackEmail ?? '',
        }
      : { kind: 'unmapped', email: cached[0].slackEmail }
  }

  // 2. Cache miss → Slack users.info with one retry on 429.
  const profile = await fetchSlackProfile({
    slackBotToken,
    slackUserId,
    log,
  })
  if (profile.kind === 'transient_failure') return profile
  if (profile.kind === 'bot_token_revoked') return profile
  if (profile.kind === 'not_found') {
    // 404 — Slack says no such user. Cache as unmapped so we don't
    // re-attempt forever.
    await insertMapping(db, {
      workspaceId,
      slackUserId,
      cyggieUserId: null,
      email: null,
    })
    return { kind: 'unmapped', email: null }
  }

  // 3. Resolve email → Cyggie user.
  const email = (profile.email ?? '').toLowerCase()
  let cyggieUserId: string | null = null
  if (email) {
    const userRows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1)
    cyggieUserId = userRows[0]?.id ?? null
  }

  // 4. Cache the mapping (mapped OR unmapped — both are stable states).
  //    Race tolerance: if a concurrent request inserts first, the
  //    unique index throws 23505; we swallow it and read back the
  //    winner's row.
  try {
    await insertMapping(db, {
      workspaceId,
      slackUserId,
      cyggieUserId,
      email: email || null,
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent insert won — return what's in the DB now.
      const winner = await db
        .select({
          cyggieUserId: schema.slackUserMappings.cyggieUserId,
          slackEmail: schema.slackUserMappings.slackEmail,
        })
        .from(schema.slackUserMappings)
        .where(
          and(
            eq(schema.slackUserMappings.slackWorkspaceId, workspaceId),
            eq(schema.slackUserMappings.slackUserId, slackUserId),
          ),
        )
        .limit(1)
      if (winner[0]) {
        return winner[0].cyggieUserId
          ? {
              kind: 'mapped',
              cyggieUserId: winner[0].cyggieUserId,
              email: winner[0].slackEmail ?? '',
            }
          : { kind: 'unmapped', email: winner[0].slackEmail }
      }
    }
    throw err
  }

  return cyggieUserId
    ? { kind: 'mapped', cyggieUserId, email }
    : { kind: 'unmapped', email: email || null }
}

// ─── Slack users.info ────────────────────────────────────────────────

type SlackProfileResult =
  | { kind: 'ok'; email: string | null }
  | { kind: 'transient_failure' }
  | { kind: 'bot_token_revoked' }
  | { kind: 'not_found' }

async function fetchSlackProfile(args: {
  slackBotToken: string
  slackUserId: string
  log?: FastifyBaseLogger
}): Promise<SlackProfileResult> {
  const { slackBotToken, slackUserId, log } = args
  // Direct WebClient construction (not via makeSlackClient) because
  // users.info isn't part of our SlackClient interface — that's
  // intentionally narrow for chat surfaces.
  const web = new WebClient(slackBotToken)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await web.users.info({ user: slackUserId })
      if (!res.ok) {
        // The SDK throws on non-ok in newer versions; defensive branch.
        log?.warn(
          { slackUserId, error: res.error },
          'slack users.info returned not-ok',
        )
        return { kind: 'transient_failure' }
      }
      const email =
        (res.user as { profile?: { email?: string } } | undefined)?.profile?.email ??
        null
      return { kind: 'ok', email }
    } catch (err) {
      const slackErr = err as { data?: { error?: string }; code?: string }
      const errorCode = slackErr.data?.error
      if (errorCode === 'invalid_auth' || errorCode === 'not_authed') {
        log?.error(
          {
            metric: 'slack_token_revoked',
            slackUserId,
          },
          'slack users.info returned invalid_auth — bot token revoked',
        )
        Sentry.captureMessage('Slack bot token revoked', {
          tags: { security: 'slack_token_revoked' },
          level: 'error',
        })
        return { kind: 'bot_token_revoked' }
      }
      if (errorCode === 'user_not_found') {
        return { kind: 'not_found' }
      }
      if (
        errorCode === 'ratelimited' ||
        slackErr.code === 'ECONNRESET' ||
        slackErr.code === 'ETIMEDOUT'
      ) {
        if (attempt === 0) {
          // Retry once.
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        log?.warn(
          { slackUserId, errorCode },
          'slack users.info: rate limited / transient after retry',
        )
        return { kind: 'transient_failure' }
      }
      // Unknown error — Sentry + transient (don't cache; let the next
      // call retry).
      log?.error(
        { err, slackUserId },
        'slack users.info: unexpected error',
      )
      Sentry.captureException(err, {
        tags: { surface: 'slack_users_info' },
      })
      return { kind: 'transient_failure' }
    }
  }
  return { kind: 'transient_failure' }
}

// ─── DB helpers ──────────────────────────────────────────────────────

async function insertMapping(
  db: ReturnType<typeof getDb>,
  args: {
    workspaceId: string
    slackUserId: string
    cyggieUserId: string | null
    email: string | null
  },
): Promise<void> {
  await db.insert(schema.slackUserMappings).values({
    id: createId(),
    slackWorkspaceId: args.workspaceId,
    slackUserId: args.slackUserId,
    cyggieUserId: args.cyggieUserId,
    slackEmail: args.email,
  })
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  )
}

// Re-export for tests + symmetry with other slack/* surfaces.
export type { SlackClient }
