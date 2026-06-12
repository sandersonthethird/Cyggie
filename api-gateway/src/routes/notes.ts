import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import { validateClientLamport } from '../sync/validate-lamport'
import type { GatewayEnv } from '../env'

// =============================================================================
// /notes — M2 read surface for the unified notes table.
//
// List sort: pinned DESC → updatedAt DESC. The desktop's Notes pane uses the
// same ordering, so users see identical lists across surfaces.
//
// FTS is mounted via the GIN expression index on
//   to_tsvector('english', coalesce(title,'') || ' ' || substring(content for 500000))
// so ?q=… falls through to that path with `plainto_tsquery`.
//
// Filters (all optional, mutually compatible):
//   • companyId  — notes attached to a specific company
//   • contactId  — notes attached to a specific contact
//   • meetingId  — notes that originated from a specific meeting
//   • untagged   — notes with no company/contact attachment (default-off)
//   • folderPath — notes in a specific folder. Sentinel "__inbox__" matches
//                  notes with folder_path IS NULL (the desktop "Inbox").
// =============================================================================

// Mirrors the desktop FolderSidebar INBOX_SENTINEL — passed as ?folderPath
// to filter for unfoldered notes (folder_path IS NULL).
const INBOX_SENTINEL = '__inbox__'

const NoteListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  contentPreview: z.string(), // first 200 chars, single-line
  isPinned: z.boolean(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  sourceMeetingId: z.string().nullable(),
  folderPath: z.string().nullable(),
  importSource: z.string().nullable(),
  updatedAt: z.string(),
})

const NoteDetailSchema = NoteListItemSchema.extend({
  content: z.string(),
  sourceMeetingTitle: z.string().nullable(),
  createdAt: z.string(),
})

function buildPreview(content: string): string {
  // Single-line, collapse whitespace, truncate. Mirrors the desktop NotesPanel
  // preview so a note shows the same first line in both surfaces.
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= 200) return flat
  return flat.slice(0, 197) + '…'
}

export async function registerNoteRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────
  // GET /notes — paginated list with optional filters + FTS search.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/notes',
    schema: {
      querystring: z.object({
        q: z.string().max(200).optional(),
        companyId: z.string().max(64).optional(),
        contactId: z.string().max(64).optional(),
        meetingId: z.string().max(64).optional(),
        untagged: z.coerce.boolean().optional(),
        folderPath: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      response: {
        200: z.object({
          notes: z.array(NoteListItemSchema),
          total: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const {
        q,
        companyId,
        contactId,
        meetingId,
        untagged,
        folderPath,
        limit,
        offset,
      } = req.query

      const whereClauses = [eq(schema.notes.userId, user.sub)]
      if (companyId) whereClauses.push(eq(schema.notes.companyId, companyId))
      if (contactId) whereClauses.push(eq(schema.notes.contactId, contactId))
      if (meetingId) whereClauses.push(eq(schema.notes.sourceMeetingId, meetingId))
      if (untagged) {
        whereClauses.push(isNull(schema.notes.companyId))
        whereClauses.push(isNull(schema.notes.contactId))
      }
      if (folderPath === INBOX_SENTINEL) {
        whereClauses.push(isNull(schema.notes.folderPath))
      } else if (folderPath) {
        whereClauses.push(eq(schema.notes.folderPath, folderPath))
      }
      if (q) {
        // Full-text search via the GIN expression index. The expression must
        // match the index exactly so PG can use it (otherwise it falls back to
        // a seq scan — still correct, just slower).
        whereClauses.push(
          sql`to_tsvector('english', coalesce(${schema.notes.title}, '') || ' ' || substring(${schema.notes.content} from 1 for 500000)) @@ plainto_tsquery('english', ${q})`,
        )
      }

      const rows = await db
        .select({
          id: schema.notes.id,
          title: schema.notes.title,
          content: schema.notes.content,
          isPinned: schema.notes.isPinned,
          companyId: schema.notes.companyId,
          companyName: schema.orgCompanies.canonicalName,
          contactId: schema.notes.contactId,
          contactName: schema.contacts.fullName,
          sourceMeetingId: schema.notes.sourceMeetingId,
          folderPath: schema.notes.folderPath,
          importSource: schema.notes.importSource,
          updatedAt: schema.notes.updatedAt,
        })
        .from(schema.notes)
        .leftJoin(
          schema.orgCompanies,
          eq(schema.notes.companyId, schema.orgCompanies.id),
        )
        .leftJoin(
          schema.contacts,
          eq(schema.notes.contactId, schema.contacts.id),
        )
        .where(and(...whereClauses))
        .orderBy(desc(schema.notes.isPinned), desc(schema.notes.updatedAt))
        .limit(limit)
        .offset(offset)

      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .where(and(...whereClauses))

      return {
        notes: rows.map((r) => ({
          id: r.id,
          title: r.title,
          contentPreview: buildPreview(r.content ?? ''),
          isPinned: r.isPinned,
          companyId: r.companyId,
          companyName: r.companyName,
          contactId: r.contactId,
          contactName: r.contactName,
          sourceMeetingId: r.sourceMeetingId,
          folderPath: r.folderPath,
          importSource: r.importSource,
          updatedAt: new Date(r.updatedAt).toISOString(),
        })),
        total: countRow?.n ?? 0,
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /notes/:id — full content + joined entity names.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/notes/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: NoteDetailSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      const [row] = await db
        .select({
          id: schema.notes.id,
          title: schema.notes.title,
          content: schema.notes.content,
          isPinned: schema.notes.isPinned,
          companyId: schema.notes.companyId,
          companyName: schema.orgCompanies.canonicalName,
          contactId: schema.notes.contactId,
          contactName: schema.contacts.fullName,
          sourceMeetingId: schema.notes.sourceMeetingId,
          sourceMeetingTitle: schema.meetings.title,
          folderPath: schema.notes.folderPath,
          importSource: schema.notes.importSource,
          createdAt: schema.notes.createdAt,
          updatedAt: schema.notes.updatedAt,
        })
        .from(schema.notes)
        .leftJoin(
          schema.orgCompanies,
          eq(schema.notes.companyId, schema.orgCompanies.id),
        )
        .leftJoin(schema.contacts, eq(schema.notes.contactId, schema.contacts.id))
        .leftJoin(
          schema.meetings,
          eq(schema.notes.sourceMeetingId, schema.meetings.id),
        )
        .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, user.sub)))
        .limit(1)

      if (!row) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        })
      }

      const content = row.content ?? ''
      return {
        id: row.id,
        title: row.title,
        content,
        contentPreview: buildPreview(content),
        isPinned: row.isPinned,
        companyId: row.companyId,
        companyName: row.companyName,
        contactId: row.contactId,
        contactName: row.contactName,
        sourceMeetingId: row.sourceMeetingId,
        sourceMeetingTitle: row.sourceMeetingTitle,
        folderPath: row.folderPath,
        importSource: row.importSource,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // PATCH /notes/:id — partial edit (title / content) with client-sourced
  // lamport Last-Write-Wins. Mirrors PATCH /contacts/:id and PATCH
  // /meetings/:id exactly:
  //   1. validate the lamport ceiling (reject forged far-future values 400)
  //   2. load the note scoped to (id, userId) — 404 if not the caller's
  //   3. if incoming lamport <= stored → 409 with the current note so the
  //      client can reconcile (mobile refetches + retries)
  //   4. otherwise UPDATE + RETURNING, bumping updated_at / updated_by
  //
  // The write lands directly in Neon; the notes table is an owned, synced
  // table (packages/db/src/sync/owned-tables.ts), so the desktop's sync-pull
  // carries the edit back to SQLite via the bumped lamport — no extra plumbing.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/notes/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        title: z.string().max(500).nullable().optional(),
        content: z.string().max(100_000).optional(),
        lamport: z.string().min(1).max(40),
      }),
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const body = req.body

      const lamportCheck = validateClientLamport(body.lamport)
      if (!lamportCheck.valid) {
        req.log.warn(
          {
            noteId: id,
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'notes.patch.lamport_rejected',
          },
          'patch rejected: lamport out of range',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'LAMPORT_OUT_OF_RANGE',
          message:
            lamportCheck.reason === 'unparseable'
              ? 'lamport is not a valid integer'
              : 'lamport is too far in the future',
        })
      }

      const existing = await db.query.notes.findFirst({
        where: and(eq(schema.notes.id, id), eq(schema.notes.userId, user.sub)),
      })
      if (!existing) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        })
      }

      const incoming = lamportCheck.bigint
      const stored = BigInt(existing.lamport ?? '0')
      if (incoming <= stored) {
        req.log.info(
          {
            noteId: id,
            userId: user.sub,
            incoming: body.lamport,
            stored: existing.lamport,
            metric: 'notes.patch.conflict_409',
          },
          'patch rejected: lamport not strictly greater than stored',
        )
        return reply.code(409).send({
          id: existing.id,
          title: existing.title,
          content: existing.content,
          isPinned: existing.isPinned,
          lamport: existing.lamport,
        })
      }

      const updates: Partial<typeof schema.notes.$inferInsert> = {
        lamport: body.lamport,
        updatedAt: new Date(),
        updatedByUserId: user.sub,
      }
      let hasField = false
      if (body.title !== undefined) {
        const t = body.title?.trim()
        updates.title = t ? t.slice(0, 500) : null
        hasField = true
      }
      if (body.content !== undefined) {
        // content is NOT NULL in the schema — store '' when cleared.
        updates.content = body.content.slice(0, 100_000)
        hasField = true
      }
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'NOTE_PATCH_EMPTY',
          message: 'PATCH must include at least one of: title, content.',
        })
      }

      const [updated] = await db
        .update(schema.notes)
        .set(updates)
        .where(eq(schema.notes.id, id))
        .returning()

      req.log.info(
        {
          noteId: id,
          userId: user.sub,
          metric: 'notes.patch.success',
          changed: Object.keys(updates),
          // size deltas only — never the note content itself
          contentLenFrom: (existing.content ?? '').length,
          contentLenTo: (updated.content ?? '').length,
        },
        'note patched',
      )

      return {
        id: updated.id,
        title: updated.title,
        content: updated.content ?? '',
        isPinned: updated.isPinned,
        lamport: updated.lamport,
        updatedAt: new Date(updated.updatedAt).toISOString(),
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /note-folders — list folders + per-folder note counts for the
  // mobile folder picker. Mirrors the desktop FolderSidebar data shape
  // (folder paths + count badges; Inbox = unfoldered notes).
  //
  // Returns every folder the user has created (from note_folders) plus
  // every folder that has at least one note attached to it — the union
  // ensures empty folders still show up in the picker, and folders that
  // exist only because notes were imported with a folder_path still show
  // even if they were never explicitly created.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/note-folders',
    schema: {
      response: {
        200: z.object({
          folders: z.array(
            z.object({
              path: z.string(),
              count: z.number(),
            }),
          ),
          inboxCount: z.number(),
          totalCount: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)

      // Counts per non-null folder path. GROUP BY on the indexed column.
      const folderCounts = await db
        .select({
          path: schema.notes.folderPath,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.userId, user.sub),
            sql`${schema.notes.folderPath} IS NOT NULL`,
          ),
        )
        .groupBy(schema.notes.folderPath)

      // Explicitly created folders (may have count 0).
      const declaredFolders = await db
        .select({ path: schema.noteFolders.path })
        .from(schema.noteFolders)
        .where(eq(schema.noteFolders.userId, user.sub))

      // Inbox = unfoldered notes count.
      const [inboxRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.userId, user.sub),
            isNull(schema.notes.folderPath),
          ),
        )

      const [totalRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .where(eq(schema.notes.userId, user.sub))

      const countByPath = new Map<string, number>()
      for (const r of folderCounts) {
        if (r.path) countByPath.set(r.path, r.count)
      }
      for (const f of declaredFolders) {
        if (!countByPath.has(f.path)) countByPath.set(f.path, 0)
      }

      const folders = Array.from(countByPath.entries())
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => a.path.localeCompare(b.path))

      return {
        folders,
        inboxCount: inboxRow?.n ?? 0,
        totalCount: totalRow?.n ?? 0,
      }
    },
  })
}

// Re-export for clients that need to special-case the Inbox bucket.
export { INBOX_SENTINEL as NOTES_INBOX_SENTINEL }
