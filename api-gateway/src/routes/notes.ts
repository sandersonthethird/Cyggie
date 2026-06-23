import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import { validateClientLamport } from '../sync/validate-lamport'
import { noteVisibilityFilter } from '../notes/visibility'
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
  // Privacy + authorship for the collective-firm-memory surface. `isPrivate`
  // drives the "Only you" vs "Visible to firm" affordance; author* identify a
  // teammate's note ("Shared by …"). A note is the viewer's own iff
  // authorUserId === their user id.
  isPrivate: z.boolean(),
  authorUserId: z.string(),
  authorName: z.string().nullable(),
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

// The joined-row shape every NoteDetail response is built from. GET /notes/:id,
// POST /notes, and PATCH /notes/:id all select these columns (same joins) and
// map through `toNoteDetail`, so the response shape can never drift between the
// read and write surfaces.
interface NoteDetailRow {
  id: string
  title: string | null
  content: string | null
  isPinned: boolean
  isPrivate: boolean
  authorUserId: string
  authorName: string | null
  companyId: string | null
  companyName: string | null
  contactId: string | null
  contactName: string | null
  sourceMeetingId: string | null
  sourceMeetingTitle: string | null
  folderPath: string | null
  importSource: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

function toNoteDetail(row: NoteDetailRow): z.infer<typeof NoteDetailSchema> {
  const content = row.content ?? ''
  return {
    id: row.id,
    title: row.title,
    content,
    contentPreview: buildPreview(content),
    isPinned: row.isPinned,
    isPrivate: row.isPrivate,
    authorUserId: row.authorUserId,
    authorName: row.authorName ?? null,
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
}

type Db = ReturnType<typeof getDb>

// Loads one note as a full NoteDetail row (with author/company/contact/meeting
// joins), scoped by id only — callers that use this after a write (POST/PATCH)
// have ALREADY enforced ownership, so no visibility filter is applied here.
// Returns null if the id doesn't exist. Reused so the write endpoints return
// the exact same shape as GET /notes/:id (decision 4A).
async function loadNoteDetailById(
  db: Db,
  id: string,
): Promise<z.infer<typeof NoteDetailSchema> | null> {
  const [row] = await db
    .select({
      id: schema.notes.id,
      title: schema.notes.title,
      content: schema.notes.content,
      isPinned: schema.notes.isPinned,
      isPrivate: schema.notes.isPrivate,
      authorUserId: schema.notes.userId,
      authorName: schema.users.displayName,
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
    .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
    .leftJoin(schema.orgCompanies, eq(schema.notes.companyId, schema.orgCompanies.id))
    .leftJoin(schema.contacts, eq(schema.notes.contactId, schema.contacts.id))
    .leftJoin(schema.meetings, eq(schema.notes.sourceMeetingId, schema.meetings.id))
    .where(eq(schema.notes.id, id))
    .limit(1)
  return row ? toNoteDetail(row) : null
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
        // 'private' = the viewer's own owner-only notes (is_private = true).
        // 'shared'  = firm-visible notes (tagged AND not private), incl.
        // teammates'. Absent = no visibility narrowing. Optional + additive so
        // existing clients are unaffected.
        visibility: z.enum(['private', 'shared']).optional(),
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
        visibility,
        folderPath,
        limit,
        offset,
      } = req.query

      // Firm-visibility predicate (own notes + teammates' tagged, non-private
      // notes), enforced via the single contract in ../notes/visibility. The
      // inner-join on users below gives the predicate its firm guard and the
      // author-name column in one pass.
      const whereClauses = [noteVisibilityFilter(user)]
      if (companyId) whereClauses.push(eq(schema.notes.companyId, companyId))
      if (contactId) whereClauses.push(eq(schema.notes.contactId, contactId))
      if (meetingId) whereClauses.push(eq(schema.notes.sourceMeetingId, meetingId))
      if (untagged) {
        whereClauses.push(isNull(schema.notes.companyId))
        whereClauses.push(isNull(schema.notes.contactId))
      }
      // Visibility narrowing layered on top of noteVisibilityFilter:
      //   private → only the viewer's own private notes (the lock-icon ones).
      //             The base filter already restricts private rows to the owner,
      //             so is_private = true alone yields exactly "my private notes".
      //   shared  → firm-visible notes = tagged AND not private (own + teammate).
      if (visibility === 'private') {
        whereClauses.push(eq(schema.notes.isPrivate, true))
      } else if (visibility === 'shared') {
        whereClauses.push(eq(schema.notes.isPrivate, false))
        whereClauses.push(
          or(
            isNotNull(schema.notes.companyId),
            isNotNull(schema.notes.contactId),
          )!,
        )
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
          isPrivate: schema.notes.isPrivate,
          authorUserId: schema.notes.userId,
          authorName: schema.users.displayName,
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
        // INNER JOIN on the note owner: serves the visibility firm guard AND
        // the author name. Inner (not left) is safe — user_id is NOT NULL.
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
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

      // Count reuses the same join + predicate so `total` reflects exactly the
      // visibility-filtered set (pagination + FTS inherit visibility for free).
      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
        .where(and(...whereClauses))

      // Day-1 signal that collective memory is actually flowing: how many of the
      // served rows belong to a teammate (never the note bodies — count only).
      const crossUser = rows.filter((r) => r.authorUserId !== user.sub).length
      if (crossUser > 0) {
        req.log.info(
          { userId: user.sub, crossUser, metric: 'notes.served.cross_user' },
          'notes list served teammate-shared notes',
        )
      }

      return {
        notes: rows.map((r) => ({
          id: r.id,
          title: r.title,
          contentPreview: buildPreview(r.content ?? ''),
          isPinned: r.isPinned,
          isPrivate: r.isPrivate,
          authorUserId: r.authorUserId,
          authorName: r.authorName ?? null,
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
          isPrivate: schema.notes.isPrivate,
          authorUserId: schema.notes.userId,
          authorName: schema.users.displayName,
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
        // Same INNER JOIN as the list: firm guard for the visibility filter +
        // author name. A note the viewer may not see returns no row → 404 below
        // (we never disclose that the id exists).
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
        .leftJoin(
          schema.orgCompanies,
          eq(schema.notes.companyId, schema.orgCompanies.id),
        )
        .leftJoin(schema.contacts, eq(schema.notes.contactId, schema.contacts.id))
        .leftJoin(
          schema.meetings,
          eq(schema.notes.sourceMeetingId, schema.meetings.id),
        )
        .where(and(eq(schema.notes.id, id), noteVisibilityFilter(user)))
        .limit(1)

      if (!row) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        })
      }

      return toNoteDetail(row)
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
        // Privacy toggle. Additive + optional — old clients omit it. Owner-only:
        // the (id, userId) scope below means only the note's owner can flip it.
        isPrivate: z.boolean().optional(),
        // Entity tags. Additive + optional + nullable (null clears the tag).
        // Tagging a note to a company/contact is what makes it firm-visible
        // (see noteVisibilityFilter). Owner-only via the (id, userId) scope.
        companyId: z.string().max(64).nullable().optional(),
        contactId: z.string().max(64).nullable().optional(),
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
          isPrivate: existing.isPrivate,
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
      if (body.isPrivate !== undefined) {
        updates.isPrivate = body.isPrivate
        hasField = true
      }
      if (body.companyId !== undefined) {
        updates.companyId = body.companyId
        hasField = true
      }
      if (body.contactId !== undefined) {
        updates.contactId = body.contactId
        hasField = true
      }
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'NOTE_PATCH_EMPTY',
          message:
            'PATCH must include at least one of: title, content, isPrivate, companyId, contactId.',
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

      // Decision 4A: return the full NoteDetail (joined company/contact/meeting
      // names) via the shared loader, so PATCH and POST hand the client the same
      // server-truth shape GET returns — no client-side name merging.
      const detail = await loadNoteDetailById(db, id)
      if (!detail) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        })
      }
      return detail
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // POST /notes — create a note (mobile create-parity with desktop). Mirrors
  // the PATCH lamport discipline: the write lands directly in Neon with the
  // caller as owner, and the notes table being an owned, synced table means
  // the desktop's sync-pull carries the new row back to SQLite — no extra
  // plumbing. Returns the full NoteDetail (decision 4A) so the client can seed
  // its cache without a follow-up GET. companyId/contactId are optional — the
  // mobile create flow leaves them null and tags later via PATCH.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/notes',
    schema: {
      body: z.object({
        title: z.string().max(500).nullable().optional(),
        content: z.string().max(100_000).optional(),
        folderPath: z.string().max(512).nullable().optional(),
        isPrivate: z.boolean().optional(),
        companyId: z.string().max(64).nullable().optional(),
        contactId: z.string().max(64).nullable().optional(),
        lamport: z.string().min(1).max(40),
      }),
      response: { 201: NoteDetailSchema },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const body = req.body

      const lamportCheck = validateClientLamport(body.lamport)
      if (!lamportCheck.valid) {
        req.log.warn(
          {
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'notes.create.lamport_rejected',
          },
          'create rejected: lamport out of range',
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

      const id = randomUUID()
      const title = body.title?.trim()
      const now = new Date()
      await db.insert(schema.notes).values({
        id,
        userId: user.sub,
        title: title ? title.slice(0, 500) : null,
        content: (body.content ?? '').slice(0, 100_000),
        folderPath: body.folderPath || null,
        isPrivate: body.isPrivate ?? false,
        companyId: body.companyId || null,
        contactId: body.contactId || null,
        lamport: body.lamport,
        createdByUserId: user.sub,
        updatedByUserId: user.sub,
        createdAt: now,
        updatedAt: now,
      })

      const detail = await loadNoteDetailById(db, id)
      if (!detail) {
        // Unreachable in practice (we just inserted it) — defensive.
        throw new GatewayError({
          statusCode: 500,
          code: 'NOTE_CREATE_FAILED',
          message: 'Note created but could not be loaded',
        })
      }

      req.log.info(
        {
          noteId: id,
          userId: user.sub,
          metric: 'notes.create.success',
          tagged: Boolean(body.companyId || body.contactId),
        },
        'note created',
      )

      return reply.code(201).send(detail)
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // DELETE /notes/:id — owner-scoped delete.
  //
  //   • default → SOFT delete: an UPDATE setting deleted_at + bumping lamport.
  //     Because notes is an owned, synced table, this replicates to every
  //     device via the normal sync-pull (a hard delete can't be pulled). Every
  //     READ surface filters deleted_at IS NULL.
  //   • ?hard=true → HARD delete (orphan cleanup): the mobile editor calls this
  //     when an instant-created note is abandoned empty. The row is seconds old
  //     and was never meaningfully synced, so a hard delete avoids leaving a
  //     permanent soft-deleted junk row in Neon.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'DELETE',
    url: '/notes/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      querystring: z.object({ hard: z.coerce.boolean().optional() }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const { hard } = req.query

      const existing = await db.query.notes.findFirst({
        where: and(eq(schema.notes.id, id), eq(schema.notes.userId, user.sub)),
        columns: { id: true },
      })
      if (!existing) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NOTE_NOT_FOUND',
          message: 'Note not found',
        })
      }

      if (hard) {
        await db.delete(schema.notes).where(eq(schema.notes.id, id))
      } else {
        await db
          .update(schema.notes)
          .set({
            deletedAt: new Date(),
            deletedByUserId: user.sub,
            updatedAt: new Date(),
            // Server-stamped lamport so the pull window carries the delete.
            lamport: String(Date.now()),
          })
          .where(and(eq(schema.notes.id, id), isNull(schema.notes.deletedAt)))
      }

      req.log.info(
        { noteId: id, userId: user.sub, hard: Boolean(hard), metric: 'notes.delete.success' },
        'note deleted',
      )
      return { ok: true as const }
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

      // All three counts MUST reuse the same firm-visibility contract as
      // GET /notes (noteVisibilityFilter + inner-join on users) — otherwise the
      // picker badges count only rows literally owned by user.sub while the list
      // shows the wider visible set, and the badges read 0. The filter already
      // excludes soft-deleted rows, so no separate isNull(deletedAt) is needed.
      //
      //   folder badges  ─┐
      //   inbox badge    ─┼─►  count over { own notes ∪ teammates' tagged,
      //   total badge    ─┘     non-private notes }  ==  what GET /notes returns
      //
      // NOTE (intentional): folderCounts groups across ALL visible notes, so a
      // folder path that exists only on a shared/teammate note surfaces here,
      // and totalCount can exceed inboxCount + Σ(your declared folders). That is
      // by design — the badges must match the list. Do not "fix" it back to
      // user.sub-only.
      const folderCounts = await db
        .select({
          path: schema.notes.folderPath,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.notes)
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
        .where(and(noteVisibilityFilter(user), isNotNull(schema.notes.folderPath)))
        .groupBy(schema.notes.folderPath)

      // Explicitly created folders (may have count 0). Per-user metadata —
      // intentionally scoped to the viewer; we only widen the note *counts*.
      const declaredFolders = await db
        .select({ path: schema.noteFolders.path })
        .from(schema.noteFolders)
        .where(eq(schema.noteFolders.userId, user.sub))

      // Inbox = unfoldered visible notes count.
      const [inboxRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
        .where(and(noteVisibilityFilter(user), isNull(schema.notes.folderPath)))

      const [totalRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notes)
        .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
        .where(noteVisibilityFilter(user))

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
