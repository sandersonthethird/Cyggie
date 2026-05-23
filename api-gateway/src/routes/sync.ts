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
              continue
            }
          }

          // 5. Apply
          try {
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
                continue
              }
              // Always carry the new lamport on the upsert.
              validatedPayload['lamport'] = entry.lamport
              const cols = Object.keys(validatedPayload)
              const placeholders = cols.map((_, i) => `$${i + 1}`)
              const params = cols.map((c) => validatedPayload![c])
              const conflictCols = spec.primaryKey.map((c) => `"${c}"`).join(', ')
              const updateSets = cols
                .filter((c) => !spec.primaryKey.includes(c))
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            rejected.push({ outboxId: entry.outboxId, reason: msg })
          }
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
      const rows = await db
        .select()
        .from(schema.meetings)
        .where(
          sql`${schema.meetings.userId} = ${user.sub}
              AND CAST(${schema.meetings.lamport} AS numeric) > CAST(${since} AS numeric)`,
        )
        .orderBy(sql`CAST(${schema.meetings.lamport} AS numeric) ASC`)

      const serverLamport = rows.length > 0
        ? String(
            rows.reduce((max, r) => {
              const v = BigInt(r.lamport ?? '0')
              return v > max ? v : max
            }, BigInt(since)),
          )
        : since

      req.log.info(
        {
          userId: user.sub,
          since,
          rowCount: rows.length,
          metric: 'sync.pull.row_count',
          count: rows.length,
        },
        'sync.pull complete',
      )

      return { meetings: rows, serverLamport }
    },
  })
}
