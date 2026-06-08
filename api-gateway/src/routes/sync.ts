import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { OWNED_TABLES_BY_NAME } from '@cyggie/db/sync/owned-tables'
import { decodeRowId } from '@cyggie/db/sync/encode-row-id'
import {
  validateWritePayload,
  type WriteOp,
} from '@cyggie/db/postgres/write-validators'
import { getDb, getPool } from '../db'
import type { GatewayEnv } from '../env'
import { validateClientLamport } from '../sync/validate-lamport'

// =============================================================================
// POST /sync/push — receives outbox batches from the desktop SyncAgent.
//
// Per entry:
//   1. drizzle-zod validate payload against the canonical schema.
//   2. Decode outbox.row_id (single-PK string OR composite-PK JSON).
//   3. Lookup current Postgres row's lamport.
//   4. Last-Write-Wins:
//        • incoming.lamport > existing.lamport       → apply (ack)
//        • incoming.lamport < existing.lamport       → conflict (logged,
//                                                      ack — incoming
//                                                      loses; the desktop
//                                                      drops it from its
//                                                      outbox).
//        • incoming.lamport === existing.lamport     → tiebreak by
//                                                      gateway_received_at
//                                                      ASC; whichever
//                                                      arrived first wins.
//   5. Apply: UPSERT for insert/update, DELETE for delete.
//
// Response:
//   { acked:[outboxId,…], rejected:[{outboxId,reason},…], conflicts:[…] }
//
// All entries process inside one Postgres transaction so a partial batch
// either commits in full or rolls back.
// =============================================================================

// Convert SQL column names ('canonical_name') ↔ JS property names
// ('canonicalName') so drizzle-zod (which expects camelCase) can validate
// the snake_case payload the desktop emits from SQLite row state.
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
}
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
}
function mapKeys(
  obj: Record<string, unknown>,
  fn: (k: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[fn(k)] = v
  }
  return out
}

const PushEntrySchema = z.object({
  outboxId: z.number().int(),
  table: z.string().min(1).max(64),
  rowId: z.string().min(1).max(2048),
  op: z.enum(['insert', 'update', 'delete']),
  payload: z.record(z.string(), z.unknown()).nullable(),
  lamport: z.string().min(1).max(40),
})

const PushRequestSchema = z.object({
  deviceId: z.string().min(1).max(64),
  batch: z.array(PushEntrySchema).min(1).max(500),
})

const PushResponseSchema = z.object({
  acked: z.array(z.number().int()),
  rejected: z.array(z.object({ outboxId: z.number().int(), reason: z.string() })),
  conflicts: z.array(z.object({ outboxId: z.number().int(), reason: z.string() })),
})

// In-progress meetings — see packages/db/src/schema/meetings.ts:115 for the
// full status state machine. We suppress transcript_segments on /sync/pull
// for these states so the recording desktop doesn't re-download its own
// growing transcript each pull tick (and other devices don't pay the egress
// either, since no UI shows a mid-flight transcript on a non-recording
// device). Once status flips to a terminal value, the transcript ships once.
//
// Fail-open: any status not in this set ships its transcript. So if a new
// in-progress-like state is introduced later (e.g. 'paused'), the egress
// benefit is reduced until the new value is added here, but no data is lost.
const MEETING_IN_PROGRESS_STATUSES = new Set<string>(['recording', 'transcribing'])

export async function registerSyncRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'POST',
    url: '/sync/push',
    schema: {
      body: PushRequestSchema,
      response: { 200: PushResponseSchema },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const pool = getPool(env.GATEWAY_DATABASE_URL)
      const { deviceId, batch } = req.body

      const acked: number[] = []
      const rejected: Array<{ outboxId: number; reason: string }> = []
      const conflicts: Array<{ outboxId: number; reason: string }> = []

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        for (const entry of batch) {
          // 1. Spec lookup
          const spec = OWNED_TABLES_BY_NAME.get(entry.table)
          if (!spec) {
            rejected.push({
              outboxId: entry.outboxId,
              reason: `Unknown table '${entry.table}'`,
            })
            continue
          }

          // T8 — ceiling check on incoming lamport before any DB I/O.
          // Lamport tracks wall clock on the client side; anything more
          // than 5 minutes in the future is forgery / pathological skew.
          // Reject as a per-entry rejection (NOT a batch failure) so
          // legitimate sibling rows in the batch still get applied.
          const lamportCheck = validateClientLamport(entry.lamport)
          if (!lamportCheck.valid) {
            rejected.push({
              outboxId: entry.outboxId,
              reason: `LAMPORT_OUT_OF_RANGE (${lamportCheck.reason})`,
            })
            req.log.warn(
              {
                outboxId: entry.outboxId,
                userId: user.sub,
                table: entry.table,
                rowId: entry.rowId,
                incoming: entry.lamport,
                reason: lamportCheck.reason,
                metric: 'sync.push.lamport_rejected',
              },
              'sync.push rejected entry: lamport out of range',
            )
            continue
          }

          // 2. Validate payload (skip for delete; gateway only needs the PK)
          //
          // Convention bridge: desktop emits SQL column names (snake_case)
          // in outbox.payload because it pulls rows straight from SQLite.
          // drizzle-zod validates against JS property names (camelCase). We
          // snake→camel before validation, validate, then camel→snake again
          // so the SQL we build uses real column names.
          let validatedPayload: Record<string, unknown> | null = null
          if (entry.op !== 'delete') {
            if (entry.payload == null) {
              rejected.push({
                outboxId: entry.outboxId,
                reason: 'payload required for insert/update',
              })
              continue
            }
            const camelPayload = mapKeys(entry.payload, snakeToCamel)
            // Stamp user_id from the JWT BEFORE running the drizzle-zod
            // validator. The desktop's SQLite-side tables don't always have
            // a `user_id` column (e.g. notes, where only `created_by_user_id`
            // exists), so the outbox payload arrives without one. The JWT's
            // `sub` is the canonical tenancy value either way; stamping
            // pre-validation makes the validator accept the row instead of
            // rejecting it for a missing required field. (If the payload
            // *does* carry a userId and it disagrees with the JWT, reject —
            // that's a cross-user-write attempt, defense-in-depth.)
            if (spec.hasUserId) {
              if (
                camelPayload['userId'] != null &&
                camelPayload['userId'] !== user.sub
              ) {
                rejected.push({
                  outboxId: entry.outboxId,
                  reason: `user_id mismatch (jwt=${user.sub} payload=${String(camelPayload['userId'])})`,
                })
                continue
              }
              camelPayload['userId'] = user.sub
            }
            // T17a follow-up 2026-05-23 — `created_by_user_id` and
            // `updated_by_user_id` are FKs to users.id on most owned tables
            // (notes, investment_memos, org_companies, meetings, ...). The
            // desktop's local SQLite carries the legacy `currentUserId`
            // value (a desktop-internal id from before the gateway auth
            // migration); Neon's users table only has the OAuth-backed
            // user. Rewriting these audit FKs to the JWT's `sub` mirrors
            // the user_id stamping above — same trust model (JWT is the
            // canonical actor), same defense-in-depth (we only override
            // when the payload's value differs and would otherwise FK-
            // fail). Single-firm beta makes this strictly correct; for
            // multi-user firms we'll preserve known team member ids and
            // only fall back to sub when the payload id isn't a member.
            for (const auditKey of ['createdByUserId', 'updatedByUserId'] as const) {
              if (
                camelPayload[auditKey] != null &&
                camelPayload[auditKey] !== user.sub
              ) {
                camelPayload[auditKey] = user.sub
              }
            }
            const v = validateWritePayload(
              entry.table,
              entry.op as WriteOp,
              camelPayload,
            )
            if (!v.ok) {
              rejected.push({ outboxId: entry.outboxId, reason: v.reason })
              req.log.warn(
                {
                  outboxId: entry.outboxId,
                  userId: user.sub,
                  table: entry.table,
                  op: entry.op,
                  reason: v.reason,
                  metric: 'sync.push.validation_rejected',
                },
                'sync.push rejected entry: validation failed',
              )
              continue
            }
            validatedPayload = mapKeys(v.data, camelToSnake)
          }

          // 3. Decode row_id and look up current row's lamport
          let pkCols: Record<string, unknown>
          try {
            pkCols = decodeRowId(spec, entry.rowId)
          } catch (err) {
            rejected.push({
              outboxId: entry.outboxId,
              reason: err instanceof Error ? err.message : 'rowId decode failed',
            })
            continue
          }

          // Build WHERE clause from pkCols (single or composite).
          const whereCols = Object.keys(pkCols)
          const whereSql = whereCols
            .map((c, i) => `"${c}" = $${i + 1}`)
            .join(' AND ')
          const whereParams = whereCols.map((c) => pkCols[c])

          // Defense-in-depth: also filter by user_id for owned tables.
          let userClause = ''
          const allParams: unknown[] = [...whereParams]
          if (spec.hasUserId) {
            userClause = ` AND user_id = $${allParams.length + 1}`
            allParams.push(user.sub)
          }

          // T17a follow-up (2026-05-23): wrap every DB-touching step for an
          // entry in a SAVEPOINT so one entry's failure (FK violation,
          // type coercion error, etc.) doesn't poison the rest of the
          // batch. Without this, any error here aborts the outer txn and
          // every subsequent entry's SELECT fails with 25P02 "current
          // transaction is aborted, commands ignored until end of
          // transaction block".
          await client.query('SAVEPOINT entry_sp')
          let entryFailed = false
          try {
            const existingRes = await client.query<{ lamport: string | null }>(
              `SELECT lamport FROM ${spec.table} WHERE ${whereSql}${userClause}`,
              allParams,
            )
            const existing = existingRes.rows[0]

            // 4. LWW compare
            if (existing != null) {
              const incomingLamport = BigInt(entry.lamport)
              const existingLamport = BigInt(existing.lamport ?? '0')
              if (incomingLamport < existingLamport) {
                // Loser. Don't apply; ack so desktop removes from outbox.
                conflicts.push({
                  outboxId: entry.outboxId,
                  reason: `lamport ${entry.lamport} < ${existing.lamport}`,
                })
                acked.push(entry.outboxId)
                await client.query('RELEASE SAVEPOINT entry_sp')
                continue
              }
              // Equal lamports: gateway_received_at tiebreaker. We already
              // arrived "after" the existing row (it's in the DB), so
              // existing wins. Same behavior as < case.
              if (incomingLamport === existingLamport) {
                conflicts.push({
                  outboxId: entry.outboxId,
                  reason: `lamport tie at ${entry.lamport}; gateway_received_at picked prior`,
                })
                acked.push(entry.outboxId)
                await client.query('RELEASE SAVEPOINT entry_sp')
                continue
              }
            }

            // 5. Apply
            if (entry.op === 'delete') {
              await client.query(
                `DELETE FROM ${spec.table} WHERE ${whereSql}${userClause}`,
                allParams,
              )
            } else {
              // UPSERT — insert if not present, update if present.
              if (!validatedPayload) {
                rejected.push({
                  outboxId: entry.outboxId,
                  reason: 'no payload',
                })
                await client.query('RELEASE SAVEPOINT entry_sp')
                continue
              }
              // Always carry the new lamport on the upsert.
              validatedPayload['lamport'] = entry.lamport
              const cols = Object.keys(validatedPayload)
              const placeholders = cols.map((_, i) => `$${i + 1}`)
              // node-postgres serializes JS arrays as Postgres ARRAY format
              // (`{a,b,c}`) by default — wrong for JSONB columns, which
              // expect JSON syntax (`["a","b","c"]`). For plain objects
              // node-pg already serializes via JSON.stringify, but the
              // ambiguity is real and we get "invalid input syntax for
              // type json" rejections for any meetings row whose
              // attendees / companies / chat_messages JSONB column has
              // a populated array. Pre-stringify here so the wire format
              // is unambiguous regardless of node-pg's column inference.
              // Skip Date — node-pg's native Date→timestamptz path is
              // correct and stringifying breaks it.
              const params = cols.map((c) => {
                const v = validatedPayload![c]
                if (v === null || v === undefined) return v
                if (v instanceof Date) return v
                if (typeof v === 'object') return JSON.stringify(v)
                return v
              })
              // ON CONFLICT target = the Postgres unique constraint, which can
              // be wider than the SQLite primaryKey (e.g. user_preferences:
              // SQLite (key) vs Neon (user_id, key)). Falls back to primaryKey.
              const conflictKeyCols = spec.conflictKey ?? spec.primaryKey
              const conflictCols = conflictKeyCols.map((c) => `"${c}"`).join(', ')
              const updateSets = cols
                .filter((c) => !conflictKeyCols.includes(c))
                .map((c) => `"${c}" = EXCLUDED."${c}"`)
                .join(', ')
              const upsertSql = `
                INSERT INTO ${spec.table} (${cols.map((c) => `"${c}"`).join(', ')})
                VALUES (${placeholders.join(', ')})
                ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSets || `lamport = EXCLUDED.lamport`}
              `
              await client.query(upsertSql, params)
            }
            acked.push(entry.outboxId)
            await client.query('RELEASE SAVEPOINT entry_sp')
          } catch (err) {
            entryFailed = true
            const msg = err instanceof Error ? err.message : String(err)
            await client.query('ROLLBACK TO SAVEPOINT entry_sp')
            await client.query('RELEASE SAVEPOINT entry_sp')
            rejected.push({ outboxId: entry.outboxId, reason: msg })
            // Pull Postgres-specific error fields when present (pg DatabaseError
            // exposes code/detail/hint/position/where on top of message). The
            // bare `.message` often loses the column name or offending value
            // that makes a "invalid input syntax for type json" debuggable.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pgErr = err as any
            req.log.warn(
              {
                outboxId: entry.outboxId,
                userId: user.sub,
                table: entry.table,
                op: entry.op,
                rowId: entry.rowId,
                reason: msg,
                pgCode: pgErr?.code ?? null,
                pgDetail: pgErr?.detail ?? null,
                pgHint: pgErr?.hint ?? null,
                pgPosition: pgErr?.position ?? null,
                pgWhere: pgErr?.where ?? null,
                pgColumn: pgErr?.column ?? null,
                pgRoutine: pgErr?.routine ?? null,
                metric: 'sync.push.sql_failed',
              },
              'sync.push rejected entry: sql failure',
            )
          }
          // Silence "declared but never read" — `entryFailed` is the
          // contract that future code (retry, DLQ promotion) can hang
          // off without re-grepping rejected[].
          void entryFailed
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        req.log.error({ err, deviceId, userId: user.sub }, 'sync.push failed')
        throw err
      } finally {
        client.release()
      }

      req.log.info(
        {
          deviceId,
          userId: user.sub,
          batchSize: batch.length,
          acked: acked.length,
          rejected: rejected.length,
          conflicts: conflicts.length,
        },
        'sync.push complete',
      )

      return reply.send({ acked, rejected, conflicts })
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /sync/pull?since=<lamport> — mobile pulls deltas from Neon.
  //
  // Returns user-scoped meetings rows with lamport > since, ordered by
  // lamport ASC. Mobile persists the highest seen lamport as
  // `lastPullLamport` in MMKV; subsequent calls only return the delta.
  //
  // No pagination per plan-ceo-review 11B — first-launch since=0 is the
  // only unbounded case, accepted for current single-firm scale. Hard
  // cliff documented at ~500 meetings/user.
  //
  // For V1, only meetings are returned. Other tables can join this
  // endpoint as the schema grows (notes/contacts/etc. once Phase 1.5c
  // pulls them into the mobile read path).
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/sync/pull',
    schema: {
      querystring: z.object({
        since: z.string().min(1).max(40).default('0'),
      }),
      response: {
        200: z.object({
          meetings: z.array(z.unknown()),
          notes: z.array(z.unknown()),
          orgCompanies: z.array(z.unknown()),
          orgCompanyAliases: z.array(z.unknown()),
          contacts: z.array(z.unknown()),
          contactEmails: z.array(z.unknown()),
          chatSessions: z.array(z.unknown()),
          chatSessionMessages: z.array(z.unknown()),
          userPreferences: z.array(z.unknown()),
          serverLamport: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const since = req.query.since
      const db = getDb(env.GATEWAY_DATABASE_URL)

      // BigInt-safe comparison via explicit numeric cast. Lamport is stored as
      // text because Postgres bigint values can exceed JS safe-integer range
      // (matches /sync/push's serialization convention). Drizzle's gt() would
      // do lexicographic comparison on a text column — wrong for numerics —
      // so we use raw SQL fragments in the where/orderBy clauses. Going
      // through drizzle's query builder gives us camelCase row keys
      // (consistent with the rest of the API) instead of pg-pool snake_case.
      //
      // T14 — pull every owned table in parallel. The slowest one (usually
      // meetings with its jsonb transcript_segments) sets total latency.
      //
      // org_company_aliases + contact_emails don't carry user_id directly
      // (they're cascade-children); we filter via JOIN onto the parent.
      const sinceParam = since
      const [
        meetings,
        notes,
        orgCompanies,
        orgCompanyAliases,
        contacts,
        contactEmails,
        chatSessions,
        chatSessionMessages,
        userPreferences,
      ] = await Promise.all([
        db
          .select()
          .from(schema.meetings)
          .where(
            sql`${schema.meetings.userId} = ${user.sub}
                AND CAST(${schema.meetings.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.meetings.lamport} AS numeric) ASC`),
        db
          .select()
          .from(schema.notes)
          .where(
            sql`${schema.notes.userId} = ${user.sub}
                AND CAST(${schema.notes.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.notes.lamport} AS numeric) ASC`),
        db
          .select()
          .from(schema.orgCompanies)
          .where(
            sql`${schema.orgCompanies.userId} = ${user.sub}
                AND CAST(${schema.orgCompanies.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.orgCompanies.lamport} AS numeric) ASC`),
        // org_company_aliases: scope via INNER JOIN onto org_companies for
        // user_id, but select only alias columns so the row shape matches
        // the table's drizzle-zod schema (camelCase, no extra parent fields).
        db
          .select({
            id: schema.orgCompanyAliases.id,
            companyId: schema.orgCompanyAliases.companyId,
            aliasValue: schema.orgCompanyAliases.aliasValue,
            aliasType: schema.orgCompanyAliases.aliasType,
            lamport: schema.orgCompanyAliases.lamport,
            createdAt: schema.orgCompanyAliases.createdAt,
          })
          .from(schema.orgCompanyAliases)
          .innerJoin(
            schema.orgCompanies,
            sql`${schema.orgCompanies.id} = ${schema.orgCompanyAliases.companyId}`,
          )
          .where(
            sql`${schema.orgCompanies.userId} = ${user.sub}
                AND CAST(${schema.orgCompanyAliases.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.orgCompanyAliases.lamport} AS numeric) ASC`),
        db
          .select()
          .from(schema.contacts)
          .where(
            sql`${schema.contacts.userId} = ${user.sub}
                AND CAST(${schema.contacts.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.contacts.lamport} AS numeric) ASC`),
        // contact_emails: scope via INNER JOIN onto contacts for user_id;
        // select only email columns to keep the row shape clean.
        db
          .select({
            contactId: schema.contactEmails.contactId,
            email: schema.contactEmails.email,
            isPrimary: schema.contactEmails.isPrimary,
            lamport: schema.contactEmails.lamport,
            createdAt: schema.contactEmails.createdAt,
          })
          .from(schema.contactEmails)
          .innerJoin(
            schema.contacts,
            sql`${schema.contacts.id} = ${schema.contactEmails.contactId}`,
          )
          .where(
            sql`${schema.contacts.userId} = ${user.sub}
                AND CAST(${schema.contactEmails.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.contactEmails.lamport} AS numeric) ASC`),
        // 2026-05-24 — chat_sessions: scope by userId (column on row).
        db
          .select()
          .from(schema.chatSessions)
          .where(
            sql`${schema.chatSessions.userId} = ${user.sub}
                AND CAST(${schema.chatSessions.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.chatSessions.lamport} AS numeric) ASC`),
        // chat_session_messages: composite ownership via JOIN onto
        // chat_sessions.user_id (the messages table has no user_id
        // column of its own).
        db
          .select({
            id: schema.chatSessionMessages.id,
            sessionId: schema.chatSessionMessages.sessionId,
            role: schema.chatSessionMessages.role,
            content: schema.chatSessionMessages.content,
            citations: schema.chatSessionMessages.citations,
            attachmentsJson: schema.chatSessionMessages.attachmentsJson,
            createdAt: schema.chatSessionMessages.createdAt,
            lamport: schema.chatSessionMessages.lamport,
          })
          .from(schema.chatSessionMessages)
          .innerJoin(
            schema.chatSessions,
            sql`${schema.chatSessions.id} = ${schema.chatSessionMessages.sessionId}`,
          )
          .where(
            sql`${schema.chatSessions.userId} = ${user.sub}
                AND CAST(${schema.chatSessionMessages.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.chatSessionMessages.lamport} AS numeric) ASC`),
        // Part E — user_preferences: scoped by userId (column on row). Select
        // only the synced columns (no user_id; desktop SQLite has no such
        // column) so the wire shape matches PulledUserPreferenceRowWire.
        db
          .select({
            key: schema.userPreferences.key,
            value: schema.userPreferences.value,
            lamport: schema.userPreferences.lamport,
            updatedAt: schema.userPreferences.updatedAt,
          })
          .from(schema.userPreferences)
          .where(
            sql`${schema.userPreferences.userId} = ${user.sub}
                AND CAST(${schema.userPreferences.lamport} AS numeric) > CAST(${sinceParam} AS numeric)`,
          )
          .orderBy(sql`CAST(${schema.userPreferences.lamport} AS numeric) ASC`),
      ])

      // Suppress transcript_segments for in-progress meetings so the recording
      // desktop doesn't re-download its own growing transcript every 60s. The
      // apply-side COALESCE in upsertMeetingRow (sync-remote-apply.ts) treats
      // null as "preserve local" so a cross-device metadata bump on an
      // in-progress meeting can't clobber the desktop's live transcript.
      for (const m of meetings as Array<{ status: string; transcriptSegments: unknown }>) {
        if (MEETING_IN_PROGRESS_STATUSES.has(m.status)) {
          m.transcriptSegments = null
        }
      }

      const allRows = [
        ...meetings,
        ...notes,
        ...orgCompanies,
        ...orgCompanyAliases,
        ...contacts,
        ...contactEmails,
        ...chatSessions,
        ...chatSessionMessages,
        ...userPreferences,
      ] as Array<{ lamport: string | null }>
      const serverLamport = allRows.length > 0
        ? String(
            allRows.reduce((max, r) => {
              const v = BigInt(r.lamport ?? '0')
              return v > max ? v : max
            }, BigInt(since)),
          )
        : since

      req.log.info(
        {
          userId: user.sub,
          since,
          meetingCount: meetings.length,
          noteCount: notes.length,
          orgCompanyCount: orgCompanies.length,
          orgCompanyAliasCount: orgCompanyAliases.length,
          contactCount: contacts.length,
          contactEmailCount: contactEmails.length,
          chatSessionCount: chatSessions.length,
          chatSessionMessageCount: chatSessionMessages.length,
          userPreferenceCount: userPreferences.length,
          metric: 'sync.pull.row_count',
        },
        'sync.pull complete',
      )

      return {
        meetings,
        notes,
        orgCompanies,
        orgCompanyAliases,
        contacts,
        contactEmails,
        chatSessions,
        chatSessionMessages,
        userPreferences,
        serverLamport,
      }
    },
  })
}
