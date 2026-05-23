import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

// =============================================================================
// /memos — read-only mobile surface for investment memos.
//
// Memo WRITING lives on desktop; this gateway exposes only GET routes so
// mobile can render a Memos tab on the company-detail screen + a memo
// detail screen with the latest version's markdown.
//
// Resolution / shape:
//   GET /memos?companyId=:id
//     Lists memos for the (user, company) tuple. INNER JOIN against
//     investment_memo_versions on memoId + latestVersionNumber so we
//     can include a preview snippet from the latest version. Memos
//     with no matching version row (latestVersionNumber=0 OR data
//     integrity issue) are SILENTLY DROPPED and counted via the
//     metric=memos.list.orphan_skipped log line.
//
//   GET /memos/:id
//     Fetches a single memo + latest version contentMarkdown.
//     contentMarkdown may be empty/null — the mobile client renders
//     a "still being drafted on desktop" state for that case (we do
//     NOT 404; the memo does exist, it's just empty).
//
// =============================================================================

const MemoListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  latestVersionNumber: z.number(),
  updatedAt: z.string(),
  preview: z.string(),
})

const MemoDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  contentMarkdown: z.string().nullable(),
  latestVersionNumber: z.number(),
  updatedAt: z.string(),
})

// Strip markdown syntax for the list preview. Naive but deterministic;
// good enough for a 200-char snippet. Doesn't try to handle every edge
// case (escaped chars, nested fences, etc.) — that's overkill for a
// list preview.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`]+`/g, '') // inline code
    .replace(/^#{1,6}\s+/gm, '') // ATX headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italics
    .replace(/__([^_]+)__/g, '$1') // bold (underscore)
    .replace(/_([^_]+)_/g, '$1') // italics (underscore)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/^[-*+]\s+/gm, '') // list bullets
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list
    .replace(/^>\s*/gm, '') // blockquotes
    .replace(/\n{2,}/g, ' ') // paragraphs → single space
    .replace(/\s+/g, ' ')
    .trim()
}

export async function registerMemoRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────
  // GET /memos?companyId=:id — list memos for a given company.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/memos',
    schema: {
      querystring: z.object({
        companyId: z.string().min(1).max(64),
      }),
      response: {
        200: z.object({
          memos: z.array(MemoListItemSchema),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { companyId } = req.query
      const startedAtMs = Date.now()

      const db = getDb(env.GATEWAY_DATABASE_URL)

      // INNER JOIN: memos with no matching version row are silently
      // dropped. Should not happen given FK cascade + the default
      // latestVersionNumber=0 meaning "no version yet", but defense
      // in depth: count drops via a follow-up SELECT below.
      let memoRows
      try {
        memoRows = await db
          .select({
            id: schema.investmentMemos.id,
            title: schema.investmentMemos.title,
            status: schema.investmentMemos.status,
            latestVersionNumber: schema.investmentMemos.latestVersionNumber,
            updatedAt: schema.investmentMemos.updatedAt,
            contentMarkdown: schema.investmentMemoVersions.contentMarkdown,
          })
          .from(schema.investmentMemos)
          .innerJoin(
            schema.investmentMemoVersions,
            and(
              eq(schema.investmentMemoVersions.memoId, schema.investmentMemos.id),
              eq(
                schema.investmentMemoVersions.versionNumber,
                schema.investmentMemos.latestVersionNumber,
              ),
            ),
          )
          .where(
            and(
              eq(schema.investmentMemos.userId, user.sub),
              eq(schema.investmentMemos.companyId, companyId),
            ),
          )
          .orderBy(desc(schema.investmentMemos.updatedAt))
      } catch (err) {
        req.log.error(
          { err, userId: user.sub, companyId },
          'memos list: db error',
        )
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to load memos',
        })
      }

      // Detect orphans: count memos owned by this user+company total,
      // compare to what INNER JOIN returned. A delta means at least
      // one memo lacks a matching version row.
      try {
        const totalRows = await db
          .select({ id: schema.investmentMemos.id })
          .from(schema.investmentMemos)
          .where(
            and(
              eq(schema.investmentMemos.userId, user.sub),
              eq(schema.investmentMemos.companyId, companyId),
            ),
          )
        const orphans = totalRows.length - memoRows.length
        if (orphans > 0) {
          // Identify which ids were dropped so the log has actionable detail.
          const seenIds = new Set(memoRows.map((r) => r.id))
          const droppedIds = totalRows.map((r) => r.id).filter((id) => !seenIds.has(id))
          req.log.warn(
            {
              metric: 'memos.list.orphan_skipped',
              userId: user.sub,
              companyId,
              orphanCount: orphans,
              droppedMemoIds: droppedIds,
            },
            'memos list: orphan memos with no version row',
          )
        }
      } catch (err) {
        // Don't fail the request on the orphan-check query — it's a
        // diagnostic, not the user-facing result.
        req.log.warn(
          { err, userId: user.sub, companyId },
          'memos list: orphan-check query failed (non-fatal)',
        )
      }

      const memos = memoRows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        latestVersionNumber: row.latestVersionNumber,
        updatedAt: row.updatedAt.toISOString(),
        preview: stripMarkdown(row.contentMarkdown).slice(0, 200),
      }))

      if (memos.length === 0) {
        req.log.info(
          {
            metric: 'memos.list.empty',
            userId: user.sub,
            companyId,
            duration_ms: Date.now() - startedAtMs,
          },
          'memos list: empty',
        )
      } else {
        req.log.info(
          {
            metric: 'memos.list.served',
            userId: user.sub,
            companyId,
            memoCount: memos.length,
            duration_ms: Date.now() - startedAtMs,
          },
          'memos list: served',
        )
      }

      return { memos }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /memos/:id — single memo + latest version's contentMarkdown.
  //
  // contentMarkdown may be null/empty — mobile renders a "still being
  // drafted on desktop" state for that case. We do NOT 404 on empty
  // content; only on missing memo or cross-user access.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/memos/:id',
    schema: {
      params: z.object({
        id: z.string().min(1).max(64),
      }),
      response: {
        200: MemoDetailSchema,
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { id } = req.params
      const startedAtMs = Date.now()

      const db = getDb(env.GATEWAY_DATABASE_URL)

      let rows
      try {
        rows = await db
          .select({
            id: schema.investmentMemos.id,
            title: schema.investmentMemos.title,
            status: schema.investmentMemos.status,
            latestVersionNumber: schema.investmentMemos.latestVersionNumber,
            updatedAt: schema.investmentMemos.updatedAt,
            contentMarkdown: schema.investmentMemoVersions.contentMarkdown,
          })
          .from(schema.investmentMemos)
          .leftJoin(
            // LEFT JOIN here (vs INNER on list) — we want to return the
            // memo metadata even if the version row is missing, then
            // hand the client a null contentMarkdown for its empty-state.
            schema.investmentMemoVersions,
            and(
              eq(schema.investmentMemoVersions.memoId, schema.investmentMemos.id),
              eq(
                schema.investmentMemoVersions.versionNumber,
                schema.investmentMemos.latestVersionNumber,
              ),
            ),
          )
          .where(
            and(
              eq(schema.investmentMemos.id, id),
              eq(schema.investmentMemos.userId, user.sub),
            ),
          )
          .limit(1)
      } catch (err) {
        req.log.error(
          { err, userId: user.sub, memoId: id },
          'memo detail: db error',
        )
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to load memo',
        })
      }

      const row = rows[0]
      if (!row) {
        req.log.info(
          { metric: 'memos.detail.not_found', userId: user.sub, memoId: id },
          'memo detail: not found',
        )
        throw new GatewayError({
          statusCode: 404,
          code: 'MEMO_NOT_FOUND',
          message: 'Memo not found',
        })
      }

      const contentMarkdown = row.contentMarkdown ?? null
      const isEmpty = !contentMarkdown || contentMarkdown.trim().length === 0

      if (isEmpty) {
        req.log.info(
          { metric: 'memos.detail.empty_content', userId: user.sub, memoId: id },
          'memo detail: empty content',
        )
      } else {
        req.log.info(
          {
            metric: 'memos.detail.served',
            userId: user.sub,
            memoId: id,
            versionNumber: row.latestVersionNumber,
            contentLength: contentMarkdown.length,
            duration_ms: Date.now() - startedAtMs,
          },
          'memo detail: served',
        )
      }

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        contentMarkdown,
        latestVersionNumber: row.latestVersionNumber,
        updatedAt: row.updatedAt.toISOString(),
      }
    },
  })
}
