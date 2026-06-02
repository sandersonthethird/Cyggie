// Slack thread ↔ chat_sessions binding (External Agents V1 slice 6).
//
// Finds or creates the chat_sessions row for a Slack thread (or DM),
// loads prior turns, and persists new user+assistant pairs after each
// successful cyggieAsk. Uses the existing chat_sessions /
// chat_session_messages tables — same persistence the in-product chat
// uses — distinguished by origin='slack'.
//
// DM handling: Slack treats each DM message as its own thread (no
// thread_ts). To preserve "follow-ups in a DM share context," we key
// DM sessions by channel_id only (slack_thread_ts = NULL). Multiple
// DMs from the same user in the same channel share one session.
//
// Per plan decision-log #17: three real columns (workspace, channel,
// thread_ts) instead of a concatenated string. Partial unique index
// uses COALESCE(thread_ts, '') so NULL DMs collapse to a single key
// per channel.

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import type { getDb } from '../db'

export interface SlackThreadKey {
  workspaceId: string
  channelId: string
  // null = DM (no thread_ts); the channel itself is the session key.
  threadTs: string | null
}

export interface SlackSessionInfo {
  id: string
  userId: string
  createdAt: Date
  isNew: boolean
}

export interface SlackSessionMessage {
  role: 'user' | 'assistant'
  content: string
}

// How many prior turns to feed back to the LLM. Slack threads can run
// forever; we cap to keep input tokens bounded. Bias toward recent.
const MAX_PRIOR_TURNS = 20

// Find-or-create the chat_sessions row for a Slack thread. Idempotent
// across concurrent requests: if two messages land at the same time,
// the partial unique index races one of them to a 23505 conflict and
// the loser re-reads the winner's row.
export async function findOrCreateSlackSession(args: {
  db: ReturnType<typeof getDb>
  userId: string
  key: SlackThreadKey
}): Promise<SlackSessionInfo> {
  const { db, userId, key } = args

  // Try to find an existing session first.
  const existing = await selectSlackSession(db, key)
  if (existing) {
    return {
      id: existing.id,
      userId: existing.userId,
      createdAt: existing.createdAt,
      isNew: false,
    }
  }

  // Create. contextId encodes the slack ref in a unique-but-readable
  // string ("slack:<workspace>:<channel>:<thread>") so the existing
  // chat_sessions_active_idx (UNIQUE on context_id WHERE is_active=1)
  // doesn't collide with in-product chat rows.
  const id = createId()
  const contextId = `slack:${key.workspaceId}:${key.channelId}:${key.threadTs ?? '_dm_'}`
  try {
    await db.insert(schema.chatSessions).values({
      id,
      userId,
      contextId,
      contextKind: 'crm',
      contextLabel: 'Slack thread',
      title: null,
      messageCount: 0,
      isActive: 1,
      isPinned: 0,
      isArchived: 0,
      lamport: '0',
      origin: 'slack',
      slackWorkspaceId: key.workspaceId,
      slackChannelId: key.channelId,
      slackThreadTs: key.threadTs,
    })
    return { id, userId, createdAt: new Date(), isNew: true }
  } catch (err) {
    // 23505 unique violation = lost the race; re-read.
    if (isUniqueViolation(err)) {
      const winner = await selectSlackSession(db, key)
      if (winner) {
        return {
          id: winner.id,
          userId: winner.userId,
          createdAt: winner.createdAt,
          isNew: false,
        }
      }
    }
    throw err
  }
}

async function selectSlackSession(
  db: ReturnType<typeof getDb>,
  key: SlackThreadKey,
): Promise<{ id: string; userId: string; createdAt: Date } | null> {
  const threadFilter = key.threadTs
    ? eq(schema.chatSessions.slackThreadTs, key.threadTs)
    : isNull(schema.chatSessions.slackThreadTs)
  const rows = await db
    .select({
      id: schema.chatSessions.id,
      userId: schema.chatSessions.userId,
      createdAt: schema.chatSessions.createdAt,
    })
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.origin, 'slack'),
        eq(schema.chatSessions.slackWorkspaceId, key.workspaceId),
        eq(schema.chatSessions.slackChannelId, key.channelId),
        threadFilter,
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  )
}

// Load prior turns to feed back to cyggieAsk. Capped at MAX_PRIOR_TURNS
// recent messages (latest at the end of the returned array).
export async function loadSlackSessionMessages(args: {
  db: ReturnType<typeof getDb>
  sessionId: string
}): Promise<SlackSessionMessage[]> {
  const { db, sessionId } = args
  const rows = await db
    .select({
      role: schema.chatSessionMessages.role,
      content: schema.chatSessionMessages.content,
      createdAt: schema.chatSessionMessages.createdAt,
    })
    .from(schema.chatSessionMessages)
    .where(eq(schema.chatSessionMessages.sessionId, sessionId))
    .orderBy(desc(schema.chatSessionMessages.createdAt))
    .limit(MAX_PRIOR_TURNS)
  // Returned DESC; reverse to ASC so the caller passes them in
  // chronological order.
  return rows
    .reverse()
    .filter(
      (r): r is { role: 'user' | 'assistant'; content: string; createdAt: Date } =>
        r.role === 'user' || r.role === 'assistant',
    )
    .map(({ role, content }) => ({ role, content }))
}

// Persist the new user + assistant pair after a successful cyggieAsk.
// Uses one transaction so partial failure (user inserted but assistant
// not) can't leave a session looking like it received but never
// responded.
export async function appendSlackTurn(args: {
  db: ReturnType<typeof getDb>
  sessionId: string
  userText: string
  assistantText: string
}): Promise<void> {
  const { db, sessionId, userText, assistantText } = args
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.insert(schema.chatSessionMessages).values([
      {
        id: createId(),
        sessionId,
        role: 'user',
        content: userText,
        lamport: '0',
        createdAt: now,
      },
      {
        id: createId(),
        sessionId,
        role: 'assistant',
        content: assistantText,
        lamport: '0',
        // 1ms later so DESC sort gives stable ordering.
        createdAt: new Date(now.getTime() + 1),
      },
    ])
    await tx
      .update(schema.chatSessions)
      .set({
        messageCount: sql`${schema.chatSessions.messageCount} + 2`,
        lastMessageAt: now,
        updatedAt: now,
        previewText: assistantText.slice(0, 200),
      })
      .where(eq(schema.chatSessions.id, sessionId))
  })
}

// Helper used by in-product chat list reads to filter Slack rows out.
// Centralized here so future readers can't forget the WHERE clause —
// instead of grep-finding every chat_sessions query, just call this.
// Slice 6 leaves the existing chat.ts route reads unchanged because
// they ALL pre-date slice 6 and predicate on userId-owned rows; for
// V1 the userId filter naturally excludes the slack default-user's
// rows from other users' lists. The defense-in-depth WHERE
// origin='app' lands in a focused follow-up PR per plan slice 6
// acceptance criteria.
export function isAppOriginFilter() {
  return eq(schema.chatSessions.origin, 'app')
}
