import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

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
        recentMeetings: recentMeetings.map((m) => ({
          id: m.id,
          title: m.title,
          date: new Date(m.date).toISOString(),
          durationSeconds: m.durationSeconds,
        })),
      }
    },
  })
}
