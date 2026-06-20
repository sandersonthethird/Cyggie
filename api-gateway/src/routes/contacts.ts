import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { validateClientLamport } from '../sync/validate-lamport'
import { entityVisibilityFilter } from '../sync/visibility'
import { sanitizeContactRow } from '../shared/sanitize-row'

/** Normalized name for dedup (matches desktop's contact.repo.ts pattern):
 *  lowercase + accents stripped + whitespace collapsed. */
function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// =============================================================================
// /contacts — M2 read surface for people in the CRM.
//
// Unlike /companies, contacts already carry a denormalized `last_meeting_at`
// column (maintained by writeWithSync hooks on the desktop side per the
// Phase 0.2 perf fix). So no last-touch subquery is needed — sort directly
// on the column. Falls back to updated_at DESC for the still-no-meeting case.
//
// Recent meetings for a contact go through meeting_speaker_contact_links
// (Speaker N at Meeting M is tagged as Contact C).
// =============================================================================

const ContactListItemSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  contactType: z.string().nullable(),
  primaryCompanyId: z.string().nullable(),
  primaryCompanyName: z.string().nullable(),
  // Domain of the primary company (joined from org_companies). Mobile uses
  // this to render the company's logo next to the affiliation. Null when
  // the contact has no primary company OR the company has no primaryDomain.
  primaryCompanyDomain: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  // Computed live (denorm last_meeting_at/last_email_at were dropped): the most
  // recent of speaker-tagged meetings + calendar-attendee-email meetings.
  lastTouchAt: z.string().nullable(),
})

// Guarded passthrough — only the guaranteed/computed fields are typed; every
// other business column flows through `.passthrough()` (minus the sanitize-row
// denylist). See api-gateway/src/shared/sanitize-row.ts.
const ContactDetailSchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    lastTouchAt: z.string().nullable(),
    recentMeetings: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        date: z.string(),
        durationSeconds: z.number().nullable(),
      }),
    ),
  })
  .passthrough()

export async function registerContactRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────
  // GET /contacts — paginated list, sorted by last-meeting DESC.
  // ?q= matches against full_name OR email substring (case-insensitive).
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/contacts',
    schema: {
      querystring: z.object({
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      response: {
        200: z.object({
          contacts: z.array(ContactListItemSchema),
          total: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { q, limit, offset } = req.query

      // Firm-shared + owner-aware privacy (was user_id-only) — teammates' shared
      // contacts are now visible; private contacts stay owner-only.
      const whereClauses = [entityVisibilityFilter('contacts', user)]
      if (q) {
        whereClauses.push(
          or(
            ilike(schema.contacts.fullName, `%${q}%`),
            ilike(schema.contacts.email, `%${q}%`),
            inArray(
              schema.contacts.id,
              db
                .select({ id: schema.contactEmails.contactId })
                .from(schema.contactEmails)
                .where(ilike(schema.contactEmails.email, `%${q}%`)),
            ),
          )!,
        )
      }

      // Live last-touch per contact = most recent of two signals, combined via
      // UNION ALL + max(): (a) speaker-tagged meetings (narrow), (b) calendar
      // meetings where one of the contact's emails is an attendee (broad). The
      // attendee signal expands meetings.attendee_emails once via LATERAL and
      // hash-joins to contact_emails — far cheaper than a per-row EXISTS. The
      // denormalized last_meeting_at/last_email_at columns were dropped (they
      // were never maintained, so the old `ORDER BY last_meeting_at` was a no-op
      // → alphabetical). See plan: contact-live-last-touch.
      const like = q ? `%${q}%` : null
      const qCond = like
        ? sql`AND (c.full_name ILIKE ${like} OR c.email ILIKE ${like} OR c.id IN (SELECT contact_id FROM contact_emails WHERE email ILIKE ${like}))`
        : sql``

      const listed = await db.execute(sql`
        WITH lt AS (
          SELECT contact_id, max(last_at) AS last_at FROM (
            SELECT mscl.contact_id AS contact_id, max(m.date) AS last_at
            FROM meeting_speaker_contact_links mscl
            JOIN meetings m ON m.id = mscl.meeting_id
            WHERE m.firm_id = ${user.firm_id} AND (m.user_id = ${user.sub} OR m.is_private = false)
            GROUP BY mscl.contact_id
            UNION ALL
            SELECT ce.contact_id AS contact_id, max(m.date) AS last_at
            FROM meetings m
            CROSS JOIN LATERAL jsonb_array_elements_text(m.attendee_emails) AS ae(email)
            JOIN contact_emails ce ON lower(ce.email) = lower(ae.email)
            WHERE m.firm_id = ${user.firm_id} AND (m.user_id = ${user.sub} OR m.is_private = false)
            GROUP BY ce.contact_id
          ) s GROUP BY contact_id
        )
        SELECT c.id, c.full_name, c.email, c.title, c.contact_type,
               c.primary_company_id,
               oc.canonical_name AS primary_company_name,
               oc.primary_domain AS primary_company_domain,
               c.city, c.state, c.street, c.postal_code, c.country,
               lt.last_at AS last_touch_at
        FROM contacts c
        LEFT JOIN org_companies oc ON c.primary_company_id = oc.id
        LEFT JOIN lt ON lt.contact_id = c.id
        WHERE c.firm_id = ${user.firm_id} AND (c.user_id = ${user.sub} OR c.is_private = false) ${qCond}
        ORDER BY lt.last_at DESC NULLS LAST, c.full_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `)

      const rows = listed.rows as Array<{
        id: string
        full_name: string
        email: string | null
        title: string | null
        contact_type: string | null
        primary_company_id: string | null
        primary_company_name: string | null
        primary_company_domain: string | null
        city: string | null
        state: string | null
        street: string | null
        postal_code: string | null
        country: string | null
        last_touch_at: string | Date | null
      }>

      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contacts)
        .where(and(...whereClauses))

      return {
        contacts: rows.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          email: r.email,
          title: r.title,
          contactType: r.contact_type,
          primaryCompanyId: r.primary_company_id,
          primaryCompanyName: r.primary_company_name,
          primaryCompanyDomain: r.primary_company_domain,
          city: r.city,
          state: r.state,
          street: r.street,
          postalCode: r.postal_code,
          country: r.country,
          lastTouchAt: r.last_touch_at ? new Date(r.last_touch_at).toISOString() : null,
        })),
        total: countRow?.n ?? 0,
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /contacts/:id — full detail + recent meetings.
  // 404 if the contact isn't owned by the caller.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/contacts/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: ContactDetailSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      // Full contact row (for guarded passthrough) + the joined company
      // name/domain via a small lookup. Mirrors the companies/:id pattern.
      const contact = await db.query.contacts.findFirst({
        where: and(eq(schema.contacts.id, id), entityVisibilityFilter('contacts', user)),
      })
      if (!contact) {
        throw new GatewayError({
          statusCode: 404,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found',
        })
      }

      let primaryCompanyName: string | null = null
      let primaryCompanyDomain: string | null = null
      if (contact.primaryCompanyId) {
        const co = await db.query.orgCompanies.findFirst({
          where: eq(schema.orgCompanies.id, contact.primaryCompanyId),
          columns: { canonicalName: true, primaryDomain: true },
        })
        primaryCompanyName = co?.canonicalName ?? null
        primaryCompanyDomain = co?.primaryDomain ?? null
      }

      // Recent meetings via the speaker→contact link table.
      const recentMeetings = await db
        .select({
          id: schema.meetings.id,
          title: schema.meetings.title,
          date: schema.meetings.date,
          durationSeconds: schema.meetings.durationSeconds,
        })
        .from(schema.meetingSpeakerContactLinks)
        .innerJoin(
          schema.meetings,
          eq(schema.meetingSpeakerContactLinks.meetingId, schema.meetings.id),
        )
        .where(
          and(
            eq(schema.meetingSpeakerContactLinks.contactId, id),
            entityVisibilityFilter('meetings', user), // firm-visible meetings, not just own
          ),
        )
        .orderBy(desc(schema.meetings.date))
        .limit(10)

      // lastTouchAt is the most recent of three signals:
      //   1. Speaker-tagged meetings via meeting_speaker_contact_links
      //      (only populated after a recording is transcribed AND a speaker
      //      is tagged — narrow coverage).
      //   2. Calendar meetings where this contact appears in attendee_emails
      //      (broad coverage — every calendar invite). Matched against the
      //      contact's primary email + contact_emails aliases.
      //   3. Denormalized contacts.last_email_at (maintained by desktop
      //      writeWithSync hooks on email writes).
      // (1) alone misses every calendar invite the contact didn't get tagged
      // in, which is why the field showed empty for most contacts.
      const aliasRows = await db
        .select({ email: schema.contactEmails.email })
        .from(schema.contactEmails)
        .where(eq(schema.contactEmails.contactId, id))

      const lowerEmails = Array.from(
        new Set(
          [contact.email, ...aliasRows.map((r) => r.email)]
            .filter((e): e is string => Boolean(e && e.trim()))
            .map((e) => e.toLowerCase().trim()),
        ),
      )

      const [speakerMeetingAgg] = await db
        .select({
          lastMeetingAt: sql<Date | null>`max(${schema.meetings.date})`,
        })
        .from(schema.meetingSpeakerContactLinks)
        .innerJoin(
          schema.meetings,
          eq(schema.meetingSpeakerContactLinks.meetingId, schema.meetings.id),
        )
        .where(
          and(
            eq(schema.meetingSpeakerContactLinks.contactId, id),
            eq(schema.meetings.userId, user.sub),
          ),
        )

      let attendeeMeetingAt: Date | null = null
      if (lowerEmails.length > 0) {
        const [attendeeAgg] = await db
          .select({
            lastMeetingAt: sql<Date | null>`max(${schema.meetings.date})`,
          })
          .from(schema.meetings)
          .where(
            and(
              eq(schema.meetings.userId, user.sub),
              sql`EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(${schema.meetings.attendeeEmails}) AS ae(email)
                WHERE lower(ae.email) IN (${sql.join(
                  lowerEmails.map((e) => sql`${e}`),
                  sql`, `,
                )})
              )`,
            ),
          )
        attendeeMeetingAt = attendeeAgg?.lastMeetingAt ?? null
      }

      const speakerMs = speakerMeetingAgg?.lastMeetingAt
        ? new Date(speakerMeetingAgg.lastMeetingAt).getTime()
        : null
      const attendeeMs = attendeeMeetingAt ? new Date(attendeeMeetingAt).getTime() : null
      // Two signals now that the denormalized last_email_at column is gone:
      // speaker-tagged meetings + calendar-attendee-email meetings.
      const candidateMs = [speakerMs, attendeeMs].filter(
        (ms): ms is number => ms != null,
      )
      const lastTouchAt =
        candidateMs.length > 0
          ? new Date(Math.max(...candidateMs)).toISOString()
          : null

      // Full-row passthrough minus the internal denylist; JSONB list columns
      // normalized to string[]; computed + joined fields added on top.
      return {
        ...sanitizeContactRow(contact),
        id: contact.id,
        fullName: contact.fullName,
        primaryCompanyName,
        primaryCompanyDomain,
        lastTouchAt,
        recentMeetings: recentMeetings.map((m) => ({
          id: m.id,
          title: m.title,
          date: new Date(m.date).toISOString(),
          durationSeconds: m.durationSeconds,
        })),
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // POST /contacts — create-on-the-fly from mobile.
  //
  // Mirrors the desktop EntityPicker's "Create '{query}'" affordance for
  // adding an attendee that isn't yet in the CRM. Mobile path is deliberately
  // bare:
  //   - Takes only fullName + optional email.
  //   - Does NOT trigger enrichment (no syncContactsFromAttendees, no
  //     company autolink, no LLM/web fetches). The user said "we can enrich
  //     on desktop"; desktop's existing enrichment flow runs when the user
  //     opens the contact there.
  //
  // Email-uniqueness collision (one contact per email per user) → 409 with
  // the existing contact so the caller can silently substitute.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/contacts',
    schema: {
      body: z.object({
        fullName: z.string().min(1).max(200),
        email: z.string().email().max(200).optional(),
      }),
      response: {
        201: ContactListItemSchema,
        409: ContactListItemSchema,
      },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { fullName, email } = req.body
      const trimmedName = fullName.trim()

      // Email-uniqueness check: contacts has UNIQUE(email) on the schema
      // side (idx_contacts_email). If an existing contact owns this email,
      // return it as a 409 so the caller silently substitutes instead of
      // creating a duplicate. Without this we'd 500 on the DB constraint.
      if (email) {
        const existing = await db
          .select()
          .from(schema.contacts)
          .where(and(eq(schema.contacts.userId, user.sub), eq(schema.contacts.email, email)))
          .limit(1)
        if (existing[0]) {
          const e = existing[0]
          return reply.code(409).send({
            id: e.id,
            fullName: e.fullName,
            email: e.email,
            title: e.title,
            contactType: e.contactType,
            primaryCompanyId: e.primaryCompanyId,
            primaryCompanyName: null,
            primaryCompanyDomain: null,
            city: e.city,
            state: e.state,
            street: e.street,
            postalCode: e.postalCode,
            country: e.country,
            lastTouchAt: null,
          })
        }
      }

      const id = createId()
      const nowDate = new Date()
      const lamport = String(Date.now())

      await db.insert(schema.contacts).values({
        id,
        userId: user.sub,
        fullName: trimmedName,
        normalizedName: normalizeName(trimmedName),
        email: email ?? null,
        lamport,
        createdAt: nowDate,
        updatedAt: nowDate,
        createdByUserId: user.sub,
        updatedByUserId: user.sub,
      })

      // If email provided, also insert into contact_emails as primary.
      // Desktop's contact write path does this too — it's the canonical
      // place email lives.
      if (email) {
        await db.insert(schema.contactEmails).values({
          contactId: id,
          email,
          isPrimary: 1,
          lamport,
          createdAt: nowDate,
        })
      }

      req.log.info(
        {
          metric: 'contacts.create.success',
          userId: user.sub,
          contactId: id,
          hasEmail: Boolean(email),
        },
        'contact created (no enrichment)',
      )

      return reply.code(201).send({
        id,
        fullName: trimmedName,
        email: email ?? null,
        title: null,
        contactType: null,
        primaryCompanyId: null,
        primaryCompanyName: null,
        primaryCompanyDomain: null,
        city: null,
        state: null,
        street: null,
        postalCode: null,
        country: null,
        lastTouchAt: null,
      })
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // PATCH /contacts/:id — partial update from mobile.
  //
  // Currently surfaces only `keyTakeawaysUserNote` since that's the first
  // mobile-editable contact field. Follows the established Lamport LWW
  // pattern from PATCH /chat/sessions/:id + PATCH /meetings/:id:
  //   1. validateClientLamport — reject unparseable / far-future lamports.
  //   2. Find the row scoped to (id, userId). 404 if missing.
  //   3. If incoming lamport <= stored, return 409 with the current state
  //      so the client can reconcile.
  //   4. Otherwise UPDATE + RETURNING. Bump updated_at + updated_by.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/contacts/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        keyTakeawaysUserNote: z.string().max(2000).nullable().optional(),
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
            contactId: id,
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'contacts.patch.lamport_rejected',
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

      const existing = await db.query.contacts.findFirst({
        where: and(
          eq(schema.contacts.id, id),
          eq(schema.contacts.userId, user.sub),
        ),
      })
      if (!existing) {
        throw new GatewayError({
          statusCode: 404,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found.',
        })
      }

      const incoming = lamportCheck.bigint
      const stored = BigInt(existing.lamport ?? '0')
      if (incoming <= stored) {
        req.log.info(
          {
            contactId: id,
            userId: user.sub,
            incoming: body.lamport,
            stored: existing.lamport,
            metric: 'contacts.patch.conflict_409',
          },
          'patch rejected: lamport not strictly greater than stored',
        )
        return reply.code(409).send({
          id: existing.id,
          keyTakeawaysUserNote: existing.keyTakeawaysUserNote,
          lamport: existing.lamport,
        })
      }

      const updates: Partial<typeof schema.contacts.$inferInsert> = {
        lamport: body.lamport,
        updatedAt: new Date(),
        updatedByUserId: user.sub,
      }
      let hasField = false
      if (body.keyTakeawaysUserNote !== undefined) {
        const v = body.keyTakeawaysUserNote
        updates.keyTakeawaysUserNote = v ? v.trim().slice(0, 2000) || null : null
        hasField = true
      }
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'CONTACT_PATCH_EMPTY',
          message: 'PATCH must include at least one of: keyTakeawaysUserNote.',
        })
      }

      const [updated] = await db
        .update(schema.contacts)
        .set(updates)
        .where(eq(schema.contacts.id, id))
        .returning()

      req.log.info(
        {
          contactId: id,
          userId: user.sub,
          metric: 'contacts.patch.success',
          changed: Object.keys(updates),
        },
        'contact patched',
      )

      return {
        id: updated.id,
        keyTakeawaysUserNote: updated.keyTakeawaysUserNote,
        lamport: updated.lamport,
      }
    },
  })
}
