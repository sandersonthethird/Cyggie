import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
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
//   • companyId — notes attached to a specific company
//   • contactId — notes attached to a specific contact
//   • meetingId — notes that originated from a specific meeting
//   • untagged  — notes with no company/contact attachment (default-off)
// =============================================================================

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
      const { q, companyId, contactId, meetingId, untagged, limit, offset } = req.query

      const whereClauses = [eq(schema.notes.userId, user.sub)]
      if (companyId) whereClauses.push(eq(schema.notes.companyId, companyId))
      if (contactId) whereClauses.push(eq(schema.notes.contactId, contactId))
      if (meetingId) whereClauses.push(eq(schema.notes.sourceMeetingId, meetingId))
      if (untagged) {
        whereClauses.push(isNull(schema.notes.companyId))
        whereClauses.push(isNull(schema.notes.contactId))
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
          isPinned: r.isPinned === 1,
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
        isPinned: row.isPinned === 1,
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
}
