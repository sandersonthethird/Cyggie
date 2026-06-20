import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { validateClientLamport } from '../sync/validate-lamport'
import { companyVisibilityFilter } from '../sync/visibility'
import { sanitizeCompanyRow } from '../shared/sanitize-row'

/** Normalized canonical name — lowercase + accents stripped + whitespace
 *  collapsed. Matches desktop's org-company.repo.ts normalization so the
 *  same dedup behavior applies whether the row was created on desktop or
 *  via this mobile-fast-path. */
function normalizeCompanyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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
  // primaryDomain is exposed on list rows so mobile can render company logos
  // (Clearbit URL derived from the domain) without a second round-trip.
  primaryDomain: z.string().nullable(),
  lastTouchAt: z.string().nullable(),
  meetingCount: z.number(),
})

// Guarded passthrough: only the fields we GUARANTEE shape for are typed here;
// every other business column on the row (minus the sanitize-row denylist)
// flows through `.passthrough()`, so new desktop fields appear on mobile with
// no schema edit. See api-gateway/src/shared/sanitize-row.ts.
const CompanyDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    lastTouchAt: z.string().nullable(),
    meetingCount: z.number(),
    // Co-investor company names from the synced company_investors join.
    coInvestors: z.array(z.string()).nullable(),
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
  .passthrough()

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
      // Companies are fully firm-shared (no is_private) — firm-scope, not user.
      const whereClauses = [companyVisibilityFilter(user)]
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
          primaryDomain: schema.orgCompanies.primaryDomain,
          lastTouchAt: lastTouchSubquery.lastTouchAt,
          meetingCount: lastTouchSubquery.meetingCount,
        })
        .from(schema.orgCompanies)
        .leftJoin(lastTouchSubquery, eq(lastTouchSubquery.companyId, schema.orgCompanies.id))
        .where(and(...whereClauses))
        // Three-key sort:
        //   1. last_touch_at DESC NULLS LAST → recently-touched companies on top,
        //      meeting-less companies sink to the tail (desired).
        //   2. created_at DESC → within the meeting-less tail, newest-added first,
        //      so a just-added company (e.g. "Superlog") sits at the top of the tail
        //      and is reachable via pagination instead of landing in arbitrary order.
        //   3. id DESC → stable tie-break so offset paging never skips/dupes a row.
        .orderBy(
          sql`${lastTouchSubquery.lastTouchAt} desc nulls last`,
          desc(schema.orgCompanies.createdAt),
          desc(schema.orgCompanies.id),
        )
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
          primaryDomain: r.primaryDomain,
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
        where: and(eq(schema.orgCompanies.id, id), companyVisibilityFilter(user)),
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

      // Co-investors: names from the synced company_investors join (the legacy
      // org_companies.co_investors column was retired). Ordered by position.
      const investorCompany = alias(schema.orgCompanies, 'investor_company')
      const coInvestorRows = await db
        .select({ name: investorCompany.canonicalName })
        .from(schema.companyInvestors)
        .innerJoin(
          investorCompany,
          eq(investorCompany.id, schema.companyInvestors.investorCompanyId),
        )
        .where(
          and(
            eq(schema.companyInvestors.companyId, id),
            eq(schema.companyInvestors.investorType, 'co_investor'),
          ),
        )
        .orderBy(schema.companyInvestors.position)
      const coInvestors = coInvestorRows.length
        ? coInvestorRows.map((r) => r.name).filter((n): n is string => Boolean(n))
        : null

      // Full-row passthrough minus the internal denylist (+ canonicalName→name).
      // Date columns serialize to ISO via Date#toJSON; computed fields are added
      // on top. New business columns flow through automatically.
      return {
        ...sanitizeCompanyRow(company),
        id: company.id,
        name: company.canonicalName,
        coInvestors,
        lastTouchAt: meetingAgg?.lastTouchAt
          ? new Date(meetingAgg.lastTouchAt).toISOString()
          : null,
        meetingCount: meetingAgg?.meetingCount ?? 0,
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

  // ───────────────────────────────────────────────────────────────────────
  // POST /companies — create-on-the-fly from mobile.
  //
  // Mirrors the desktop EntityPicker's "Create '{query}'" path for adding
  // a company to a meeting that isn't yet in the CRM. Mobile-side
  // posture is bare:
  //   - Takes only canonicalName (+ optional primaryDomain).
  //   - Does NOT trigger company enrichment (no website fetch, no LLM
  //     fallback, no aliases population). User said "we can enrich on
  //     desktop"; desktop's existing enrichment flow runs when the user
  //     opens the company there.
  //
  // normalized_name UNIQUE collision → 409 with the existing company so
  // the caller can silently substitute.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/companies',
    schema: {
      body: z.object({
        canonicalName: z.string().min(1).max(200),
        primaryDomain: z.string().max(200).optional(),
      }),
      response: {
        201: CompanyListItemSchema,
        409: CompanyListItemSchema,
      },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { canonicalName, primaryDomain } = req.body
      const trimmedName = canonicalName.trim()
      const normalized = normalizeCompanyName(trimmedName)

      // normalized_name UNIQUE collision check. org_companies has a
      // UNIQUE index on normalized_name; we look up first so we can
      // return a clean 409 with the existing row instead of 500ing.
      const existing = await db
        .select()
        .from(schema.orgCompanies)
        .where(
          and(
            eq(schema.orgCompanies.userId, user.sub),
            eq(schema.orgCompanies.normalizedName, normalized),
          ),
        )
        .limit(1)
      if (existing[0]) {
        const e = existing[0]
        return reply.code(409).send({
          id: e.id,
          name: e.canonicalName,
          industry: e.industry,
          stage: e.stage,
          pipelineStage: e.pipelineStage,
          status: e.status,
          city: e.city,
          state: e.state,
          primaryDomain: e.primaryDomain,
          lastTouchAt: null,
          meetingCount: 0,
        })
      }

      const id = createId()
      const nowDate = new Date()
      const lamport = String(Date.now())

      await db.insert(schema.orgCompanies).values({
        id,
        userId: user.sub,
        canonicalName: trimmedName,
        normalizedName: normalized,
        primaryDomain: primaryDomain ?? null,
        status: 'active',
        entityType: 'unknown',
        classificationSource: 'manual',
        lamport,
        createdAt: nowDate,
        updatedAt: nowDate,
        createdByUserId: user.sub,
        updatedByUserId: user.sub,
      })

      req.log.info(
        {
          metric: 'companies.create.success',
          userId: user.sub,
          companyId: id,
          hasDomain: Boolean(primaryDomain),
        },
        'company created (no enrichment)',
      )

      return reply.code(201).send({
        id,
        name: trimmedName,
        industry: null,
        stage: null,
        pipelineStage: null,
        status: 'active',
        city: null,
        state: null,
        primaryDomain: primaryDomain ?? null,
        lastTouchAt: null,
        meetingCount: 0,
      })
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // PATCH /companies/:id — partial update from mobile.
  //
  // Currently surfaces only `keyTakeawaysUserNote` since that's the first
  // mobile-editable company field. Same Lamport LWW pattern as
  // PATCH /contacts/:id + PATCH /chat/sessions/:id.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/companies/:id',
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
            companyId: id,
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'companies.patch.lamport_rejected',
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

      const existing = await db.query.orgCompanies.findFirst({
        where: and(
          eq(schema.orgCompanies.id, id),
          eq(schema.orgCompanies.userId, user.sub),
        ),
      })
      if (!existing) {
        throw new GatewayError({
          statusCode: 404,
          code: 'COMPANY_NOT_FOUND',
          message: 'Company not found.',
        })
      }

      const incoming = lamportCheck.bigint
      const stored = BigInt(existing.lamport ?? '0')
      if (incoming <= stored) {
        req.log.info(
          {
            companyId: id,
            userId: user.sub,
            incoming: body.lamport,
            stored: existing.lamport,
            metric: 'companies.patch.conflict_409',
          },
          'patch rejected: lamport not strictly greater than stored',
        )
        return reply.code(409).send({
          id: existing.id,
          keyTakeawaysUserNote: existing.keyTakeawaysUserNote,
          lamport: existing.lamport,
        })
      }

      const updates: Partial<typeof schema.orgCompanies.$inferInsert> = {
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
          code: 'COMPANY_PATCH_EMPTY',
          message: 'PATCH must include at least one of: keyTakeawaysUserNote.',
        })
      }

      const [updated] = await db
        .update(schema.orgCompanies)
        .set(updates)
        .where(eq(schema.orgCompanies.id, id))
        .returning()

      req.log.info(
        {
          companyId: id,
          userId: user.sub,
          metric: 'companies.patch.success',
          changed: Object.keys(updates),
        },
        'company patched',
      )

      return {
        id: updated.id,
        keyTakeawaysUserNote: updated.keyTakeawaysUserNote,
        lamport: updated.lamport,
      }
    },
  })
}

// Silence unused-import warning for isNotNull (kept around because the
// last-touch subquery may filter on `IS NOT NULL` once we paginate by it).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _isNotNullRef = isNotNull
