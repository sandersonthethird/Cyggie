import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { OWNED_TABLES_BY_NAME } from '@cyggie/db/sync/owned-tables'
import { decodeRowId } from '@cyggie/db/sync/encode-row-id'
import {
  validateWritePayload,
  type WriteOp,
} from '@cyggie/db/postgres/write-validators'
import { getPool } from '../db'
import type { GatewayEnv } from '../env'

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

          // 2. Validate payload (skip for delete; gateway only needs the PK)
          let validatedPayload: Record<string, unknown> | null = null
          if (entry.op !== 'delete') {
            if (entry.payload == null) {
              rejected.push({
                outboxId: entry.outboxId,
                reason: 'payload required for insert/update',
              })
              continue
            }
            const v = validateWritePayload(
              entry.table,
              entry.op as WriteOp,
              entry.payload,
            )
            if (!v.ok) {
              rejected.push({ outboxId: entry.outboxId, reason: v.reason })
              continue
            }
            validatedPayload = v.data
            // Force user_id alignment: every owned row's user_id MUST equal
            // the JWT's sub. Defense-in-depth against cross-user writes.
            if (spec.hasUserId) {
              if (
                validatedPayload['user_id'] != null &&
                validatedPayload['user_id'] !== user.sub
              ) {
                rejected.push({
                  outboxId: entry.outboxId,
                  reason: `user_id mismatch (jwt=${user.sub} payload=${String(validatedPayload['user_id'])})`,
                })
                continue
              }
              validatedPayload['user_id'] = user.sub
            }
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
}
