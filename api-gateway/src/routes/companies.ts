import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, isNotNull, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

// =============================================================================
// /companies — M2 read surface for the CRM's company graph.
//
// Scoping: today rows are filtered by users.id (req.user.sub) because the
// schema port hasn't yet propagated firm_id to org_companies. When that
// migration lands the WHERE clause becomes
//   `users.firm_id = req.user.firm_id` joined via users.id
// without changing the route shape.
//
// Last-touch is computed by joining meeting_company_links → meetings and
// taking MAX(meetings.date). Denormalizing a last_touch_at column on
// org_companies is in TODOS P2 — until that ships, this query carries the
// cost on every list render. Cheap at single-firm scale; revisit when a
// firm has >5K companies.
// =============================================================================

const CompanyListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().nullable(),
  stage: z.string().nullable(),
  pipelineStage: z.string().nullable(),
  status: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  lastTouchAt: z.string().nullable(),
  meetingCount: z.number(),
})

const CompanyDetailSchema = CompanyListItemSchema.extend({
  description: z.string().nullable(),
  primaryDomain: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  linkedinCompanyUrl: z.string().nullable(),
  employeeCountRange: z.string().nullable(),
  foundingYear: z.number().nullable(),
  arr: z.number().nullable(),
  runwayMonths: z.number().nullable(),
  round: z.string().nullable(),
  raiseSize: z.number().nullable(),
  totalFundingRaised: z.number().nullable(),
  recentMeetings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      date: z.string(),
      durationSeconds: z.number().nullable(),
    }),
  ),
  people: z.array(
    z.object({
      id: z.string(),
      fullName: z.string(),
      title: z.string().nullable(),
      email: z.string().nullable(),
    }),
  ),
})

export async function registerCompanyRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────
  // GET /companies — paginated list, sorted by last-touch DESC.
  // Optional ?q= filters by name substring (case-insensitive).
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/companies',
    schema: {
      querystring: z.object({
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      response: {
        200: z.object({
          companies: z.array(CompanyListItemSchema),
          total: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { q, limit, offset } = req.query

      // Subquery: per-company last_touch + meeting count.
      // We GROUP BY company_id over meeting_company_links joined to meetings.
      const lastTouchSubquery = db
        .select({
          companyId: schema.meetingCompanyLinks.companyId,
          lastTouchAt: sql<Date>`max(${schema.meetings.date})`.as('last_touch_at'),
          meetingCount: sql<number>`count(*)::int`.as('meeting_count'),
        })
        .from(schema.meetingCompanyLinks)
        .innerJoin(
          schema.meetings,
          eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
        )
        .where(eq(schema.meetings.userId, user.sub))
        .groupBy(schema.meetingCompanyLinks.companyId)
        .as('lt')

      // Main query: companies filtered by user + optional name match, joined
      // to the subquery for last-touch + count.
      const whereClauses = [eq(schema.orgCompanies.userId, user.sub)]
      if (q) whereClauses.push(ilike(schema.orgCompanies.canonicalName, `%${q}%`))

      const rows = await db
        .select({
          id: schema.orgCompanies.id,
          name: schema.orgCompanies.canonicalName,
          industry: schema.orgCompanies.industry,
          stage: schema.orgCompanies.stage,
          pipelineStage: schema.orgCompanies.pipelineStage,
          status: schema.orgCompanies.status,
          city: schema.orgCompanies.city,
          state: schema.orgCompanies.state,
          lastTouchAt: lastTouchSubquery.lastTouchAt,
          meetingCount: lastTouchSubquery.meetingCount,
        })
        .from(schema.orgCompanies)
        .leftJoin(lastTouchSubquery, eq(lastTouchSubquery.companyId, schema.orgCompanies.id))
        .where(and(...whereClauses))
        // NULLS LAST so companies with no meetings sink to the bottom.
        .orderBy(sql`${lastTouchSubquery.lastTouchAt} desc nulls last`)
        .limit(limit)
        .offset(offset)

      // Total count for paging cursor.
      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.orgCompanies)
        .where(and(...whereClauses))

      return {
        companies: rows.map((r) => ({
          id: r.id,
          name: r.name,
          industry: r.industry,
          stage: r.stage,
          pipelineStage: r.pipelineStage,
          status: r.status,
          city: r.city,
          state: r.state,
          lastTouchAt: r.lastTouchAt ? new Date(r.lastTouchAt).toISOString() : null,
          meetingCount: r.meetingCount ?? 0,
        })),
        total: countRow?.n ?? 0,
      }
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // GET /companies/:id — full detail + recent meetings + linked people.
  // 404 if the company isn't owned by the caller.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/companies/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: CompanyDetailSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      const company = await db.query.orgCompanies.findFirst({
        where: and(eq(schema.orgCompanies.id, id), eq(schema.orgCompanies.userId, user.sub)),
      })
      if (!company) {
        throw new GatewayError({
          statusCode: 404,
          code: 'COMPANY_NOT_FOUND',
          message: 'Company not found',
        })
      }

      // Recent meetings (top 10 most recent).
      const recentMeetings = await db
        .select({
          id: schema.meetings.id,
          title: schema.meetings.title,
          date: schema.meetings.date,
          durationSeconds: schema.meetings.durationSeconds,
        })
        .from(schema.meetingCompanyLinks)
        .innerJoin(
          schema.meetings,
          eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
        )
        .where(
          and(
            eq(schema.meetingCompanyLinks.companyId, id),
            eq(schema.meetings.userId, user.sub),
          ),
        )
        .orderBy(desc(schema.meetings.date))
        .limit(10)

      // Linked people: contacts with primary_company_id = id.
      // M2 follow-up: also include contacts surfaced via org_company_contacts
      // join table for non-primary affiliations.
      const people = await db
        .select({
          id: schema.contacts.id,
          fullName: schema.contacts.fullName,
          title: schema.contacts.title,
          email: schema.contacts.email,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.primaryCompanyId, id),
            eq(schema.contacts.userId, user.sub),
          ),
        )
        .limit(20)

      // Last-touch + meeting count for the detail hero stats card.
      const [meetingAgg] = await db
        .select({
          lastTouchAt: sql<Date>`max(${schema.meetings.date})`,
          meetingCount: sql<number>`count(*)::int`,
        })
        .from(schema.meetingCompanyLinks)
        .innerJoin(
          schema.meetings,
          eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
        )
        .where(
          and(
            eq(schema.meetingCompanyLinks.companyId, id),
            eq(schema.meetings.userId, user.sub),
          ),
        )

      return {
        id: company.id,
        name: company.canonicalName,
        industry: company.industry,
        stage: company.stage,
        pipelineStage: company.pipelineStage,
        status: company.status,
        city: company.city,
        state: company.state,
        lastTouchAt: meetingAgg?.lastTouchAt
          ? new Date(meetingAgg.lastTouchAt).toISOString()
          : null,
        meetingCount: meetingAgg?.meetingCount ?? 0,
        description: company.description,
        primaryDomain: company.primaryDomain,
        websiteUrl: company.websiteUrl,
        linkedinCompanyUrl: company.linkedinCompanyUrl,
        employeeCountRange: company.employeeCountRange,
        foundingYear: company.foundingYear,
        arr: company.arr,
        runwayMonths: company.runwayMonths,
        round: company.round,
        raiseSize: company.raiseSize,
        totalFundingRaised: company.totalFundingRaised,
        recentMeetings: recentMeetings.map((m) => ({
          id: m.id,
          title: m.title,
          date: new Date(m.date).toISOString(),
          durationSeconds: m.durationSeconds,
        })),
        people: people.map((p) => ({
          id: p.id,
          fullName: p.fullName,
          title: p.title,
          email: p.email,
        })),
      }
    },
  })
}

// Silence unused-import warning for isNotNull (kept around because the
// last-touch subquery may filter on `IS NOT NULL` once we paginate by it).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _isNotNullRef = isNotNull
