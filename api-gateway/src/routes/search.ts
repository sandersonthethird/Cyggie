import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'
import {
  entityVisibilityFilter,
  companyVisibilityFilter,
  noteVisibilityFilter,
} from '../sync/visibility'

// =============================================================================
// /search — universal search across companies, contacts, meetings, notes.
//
// Fan-out: each of the four entity types gets its own scoped query, all run
// in parallel. Per-type results are capped (default 5) so the UI can show
// "Top 5 in each" with a "View all in <tab>" affordance. Total counts per
// type are returned so the UI can render "5 of 23 matches" hints.
//
// Why a single endpoint vs. having the client fan out itself:
//   • One RTT instead of four (mobile networks)
//   • Server-side parallelism (Promise.all) is cheaper than client-side
//     because we share the same DB pool and JWT verification
//   • Stable response shape for caching at the TanStack layer
// =============================================================================

const CompanyHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().nullable(),
  pipelineStage: z.string().nullable(),
  primaryDomain: z.string().nullable(),
})

const ContactHitSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  primaryCompanyName: z.string().nullable(),
  primaryCompanyDomain: z.string().nullable(),
})

const MeetingHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  durationSeconds: z.number().nullable(),
})

const NoteHitSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  contentPreview: z.string(),
  companyName: z.string().nullable(),
  contactName: z.string().nullable(),
  updatedAt: z.string(),
})

const SearchResponseSchema = z.object({
  query: z.string(),
  companies: z.object({
    items: z.array(CompanyHitSchema),
    total: z.number(),
  }),
  contacts: z.object({
    items: z.array(ContactHitSchema),
    total: z.number(),
  }),
  meetings: z.object({
    items: z.array(MeetingHitSchema),
    total: z.number(),
  }),
  notes: z.object({
    items: z.array(NoteHitSchema),
    total: z.number(),
  }),
})

function buildPreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= 160) return flat
  return flat.slice(0, 157) + '…'
}

export async function registerSearchRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'GET',
    url: '/search',
    schema: {
      querystring: z.object({
        q: z.string().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(20).default(5),
      }),
      response: { 200: SearchResponseSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { q, limit } = req.query

      // -------- Companies: ilike on canonical_name. --------
      const companiesPromise = (async () => {
        const where = and(
          companyVisibilityFilter(user),
          ilike(schema.orgCompanies.canonicalName, `%${q}%`),
        )
        const [items, countRow] = await Promise.all([
          db
            .select({
              id: schema.orgCompanies.id,
              name: schema.orgCompanies.canonicalName,
              industry: schema.orgCompanies.industry,
              pipelineStage: schema.orgCompanies.pipelineStage,
              primaryDomain: schema.orgCompanies.primaryDomain,
            })
            .from(schema.orgCompanies)
            .where(where)
            .orderBy(schema.orgCompanies.canonicalName)
            .limit(limit),
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.orgCompanies)
            .where(where),
        ])
        return { items, total: countRow[0]?.n ?? 0 }
      })()

      // -------- Contacts: ilike on full_name OR email. --------
      const contactsPromise = (async () => {
        const where = and(
          entityVisibilityFilter('contacts', user),
          or(
            ilike(schema.contacts.fullName, `%${q}%`),
            ilike(schema.contacts.email, `%${q}%`),
          ),
        )
        const [items, countRow] = await Promise.all([
          db
            .select({
              id: schema.contacts.id,
              fullName: schema.contacts.fullName,
              title: schema.contacts.title,
              email: schema.contacts.email,
              primaryCompanyName: schema.orgCompanies.canonicalName,
              primaryCompanyDomain: schema.orgCompanies.primaryDomain,
            })
            .from(schema.contacts)
            .leftJoin(
              schema.orgCompanies,
              eq(schema.contacts.primaryCompanyId, schema.orgCompanies.id),
            )
            .where(where)
            .orderBy(schema.contacts.fullName)
            .limit(limit),
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.contacts)
            .where(where),
        ])
        return { items, total: countRow[0]?.n ?? 0 }
      })()

      // -------- Meetings: ilike on title. --------
      const meetingsPromise = (async () => {
        const where = and(
          entityVisibilityFilter('meetings', user),
          ilike(schema.meetings.title, `%${q}%`),
        )
        const [rows, countRow] = await Promise.all([
          db
            .select({
              id: schema.meetings.id,
              title: schema.meetings.title,
              date: schema.meetings.date,
              durationSeconds: schema.meetings.durationSeconds,
            })
            .from(schema.meetings)
            .where(where)
            .orderBy(desc(schema.meetings.date))
            .limit(limit),
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.meetings)
            .where(where),
        ])
        return {
          items: rows.map((m) => ({
            id: m.id,
            title: m.title,
            date: new Date(m.date).toISOString(),
            durationSeconds: m.durationSeconds,
          })),
          total: countRow[0]?.n ?? 0,
        }
      })()

      // -------- Notes: FTS via the GIN expression index. --------
      const notesPromise = (async () => {
        // noteVisibilityFilter needs users.firm_id → the queries below INNER JOIN
        // users on notes.user_id.
        const where = and(
          noteVisibilityFilter(user),
          sql`to_tsvector('english', coalesce(${schema.notes.title}, '') || ' ' || substring(${schema.notes.content} from 1 for 500000)) @@ plainto_tsquery('english', ${q})`,
        )
        const [rows, countRow] = await Promise.all([
          db
            .select({
              id: schema.notes.id,
              title: schema.notes.title,
              content: schema.notes.content,
              companyName: schema.orgCompanies.canonicalName,
              contactName: schema.contacts.fullName,
              updatedAt: schema.notes.updatedAt,
            })
            .from(schema.notes)
            .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
            .leftJoin(
              schema.orgCompanies,
              eq(schema.notes.companyId, schema.orgCompanies.id),
            )
            .leftJoin(
              schema.contacts,
              eq(schema.notes.contactId, schema.contacts.id),
            )
            .where(where)
            .orderBy(desc(schema.notes.updatedAt))
            .limit(limit),
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.notes)
            .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
            .where(where),
        ])
        return {
          items: rows.map((n) => ({
            id: n.id,
            title: n.title,
            contentPreview: buildPreview(n.content ?? ''),
            companyName: n.companyName,
            contactName: n.contactName,
            updatedAt: new Date(n.updatedAt).toISOString(),
          })),
          total: countRow[0]?.n ?? 0,
        }
      })()

      const [companies, contacts, meetings, notes] = await Promise.all([
        companiesPromise,
        contactsPromise,
        meetingsPromise,
        notesPromise,
      ])

      return { query: q, companies, contacts, meetings, notes }
    },
  })
}
