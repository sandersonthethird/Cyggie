import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

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
  city: z.string().nullable(),
  state: z.string().nullable(),
  lastMeetingAt: z.string().nullable(),
})

const ContactDetailSchema = ContactListItemSchema.extend({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterHandle: z.string().nullable(),
  linkedinHeadline: z.string().nullable(),
  relationshipStrength: z.string().nullable(),
  // Investor-shaped fields — surface them when present, mostly null otherwise.
  investorStage: z.string().nullable(),
  fundSize: z.number().nullable(),
  typicalCheckSizeMin: z.number().nullable(),
  typicalCheckSizeMax: z.number().nullable(),
  notes: z.string().nullable(),
  keyTakeaways: z.string().nullable(),
  lastEmailAt: z.string().nullable(),
  // Most recent of (live max meeting date via speaker_contact_links) and
  // (denormalized last_email_at). Mirrors the way company detail computes
  // last_touch from meeting_company_links — see companies.ts. Surfaced here
  // because the denormalized last_meeting_at column can be stale for contacts
  // imported outside the writeWithSync path.
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

      const whereClauses = [eq(schema.contacts.userId, user.sub)]
      if (q) {
        whereClauses.push(
          or(
            ilike(schema.contacts.fullName, `%${q}%`),
            ilike(schema.contacts.email, `%${q}%`),
          )!,
        )
      }

      const rows = await db
        .select({
          id: schema.contacts.id,
          fullName: schema.contacts.fullName,
          email: schema.contacts.email,
          title: schema.contacts.title,
          contactType: schema.contacts.contactType,
          primaryCompanyId: schema.contacts.primaryCompanyId,
          primaryCompanyName: schema.orgCompanies.canonicalName,
          city: schema.contacts.city,
          state: schema.contacts.state,
          lastMeetingAt: schema.contacts.lastMeetingAt,
        })
        .from(schema.contacts)
        .leftJoin(
          schema.orgCompanies,
          eq(schema.contacts.primaryCompanyId, schema.orgCompanies.id),
        )
        .where(and(...whereClauses))
        .orderBy(
          sql`${schema.contacts.lastMeetingAt} desc nulls last`,
          sql`${schema.contacts.fullName} asc`,
        )
        .limit(limit)
        .offset(offset)

      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contacts)
        .where(and(...whereClauses))

      return {
        contacts: rows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          email: r.email,
          title: r.title,
          contactType: r.contactType,
          primaryCompanyId: r.primaryCompanyId,
          primaryCompanyName: r.primaryCompanyName,
          city: r.city,
          state: r.state,
          lastMeetingAt: r.lastMeetingAt
            ? new Date(r.lastMeetingAt).toISOString()
            : null,
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

      const [row] = await db
        .select({
          // contacts
          id: schema.contacts.id,
          fullName: schema.contacts.fullName,
          firstName: schema.contacts.firstName,
          lastName: schema.contacts.lastName,
          email: schema.contacts.email,
          phone: schema.contacts.phone,
          title: schema.contacts.title,
          contactType: schema.contacts.contactType,
          primaryCompanyId: schema.contacts.primaryCompanyId,
          city: schema.contacts.city,
          state: schema.contacts.state,
          linkedinUrl: schema.contacts.linkedinUrl,
          twitterHandle: schema.contacts.twitterHandle,
          linkedinHeadline: schema.contacts.linkedinHeadline,
          relationshipStrength: schema.contacts.relationshipStrength,
          investorStage: schema.contacts.investorStage,
          fundSize: schema.contacts.fundSize,
          typicalCheckSizeMin: schema.contacts.typicalCheckSizeMin,
          typicalCheckSizeMax: schema.contacts.typicalCheckSizeMax,
          notes: schema.contacts.notes,
          keyTakeaways: schema.contacts.keyTakeaways,
          lastMeetingAt: schema.contacts.lastMeetingAt,
          lastEmailAt: schema.contacts.lastEmailAt,
          // joined company
          primaryCompanyName: schema.orgCompanies.canonicalName,
        })
        .from(schema.contacts)
        .leftJoin(
          schema.orgCompanies,
          eq(schema.contacts.primaryCompanyId, schema.orgCompanies.id),
        )
        .where(
          and(eq(schema.contacts.id, id), eq(schema.contacts.userId, user.sub)),
        )
        .limit(1)

      if (!row) {
        throw new GatewayError({
          statusCode: 404,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found',
        })
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
            eq(schema.meetings.userId, user.sub),
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
          [row.email, ...aliasRows.map((r) => r.email)]
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
      const emailMs = row.lastEmailAt ? new Date(row.lastEmailAt).getTime() : null
      const candidateMs = [speakerMs, attendeeMs, emailMs].filter(
        (ms): ms is number => ms != null,
      )
      const lastTouchAt =
        candidateMs.length > 0
          ? new Date(Math.max(...candidateMs)).toISOString()
          : null

      // Temporary diagnostic for the "Last touch blank" debugging in
      // 2026-05-23 — surfaces which of the three signals (speaker-link
      // meetings, calendar attendee-email match, denormalized last_email_at)
      // contributed. Remove once the push-pipeline gap is fixed and
      // backfilled.
      req.log.info(
        {
          contactId: id,
          fullName: row.fullName,
          emailsChecked: lowerEmails,
          speakerLinkLastMeetingAt: speakerMs ? new Date(speakerMs).toISOString() : null,
          attendeeEmailLastMeetingAt: attendeeMs
            ? new Date(attendeeMs).toISOString()
            : null,
          denormalizedLastEmailAt: emailMs ? new Date(emailMs).toISOString() : null,
          lastTouchAt,
        },
        'contact_last_touch_debug',
      )

      return {
        id: row.id,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        phone: row.phone,
        title: row.title,
        contactType: row.contactType,
        primaryCompanyId: row.primaryCompanyId,
        primaryCompanyName: row.primaryCompanyName,
        city: row.city,
        state: row.state,
        linkedinUrl: row.linkedinUrl,
        twitterHandle: row.twitterHandle,
        linkedinHeadline: row.linkedinHeadline,
        relationshipStrength: row.relationshipStrength,
        investorStage: row.investorStage,
        fundSize: row.fundSize,
        typicalCheckSizeMin: row.typicalCheckSizeMin,
        typicalCheckSizeMax: row.typicalCheckSizeMax,
        notes: row.notes,
        keyTakeaways: row.keyTakeaways,
        lastMeetingAt: row.lastMeetingAt
          ? new Date(row.lastMeetingAt).toISOString()
          : null,
        lastEmailAt: row.lastEmailAt
          ? new Date(row.lastEmailAt).toISOString()
          : null,
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
            city: e.city,
            state: e.state,
            lastMeetingAt: e.lastMeetingAt ? new Date(e.lastMeetingAt).toISOString() : null,
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
        city: null,
        state: null,
        lastMeetingAt: null,
      })
    },
  })
}
