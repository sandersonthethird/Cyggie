// cyggie_get_company — fuzzy-resolve a company name or id, then return
// a detailed markdown block with key fields, funding, investors, and
// activity recency.

import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import {
  cyggieUrl,
  formatDate,
  formatRecency,
  formatUSD,
  formatFundingLine,
  labeledLines,
} from '../format'
import { resolveCompany, type CompanyCandidate } from '../resolvers'

export interface CyggieGetCompanyArgs {
  db: ReturnType<typeof getDb>
  userId: string
  // Free-form: company name, normalized name, or cuid2 id. Resolver
  // handles routing.
  query: string
}

export async function cyggieGetCompany(args: CyggieGetCompanyArgs): Promise<ToolResult> {
  const { db, userId, query } = args
  const resolved = await resolveCompany({ db, userId, query })

  if (resolved.kind === 'none') {
    return err(
      ERROR_CODE.NOT_FOUND,
      `No company matches "${query}". Try a different name, the company's domain, or use cyggie_search.`,
    )
  }

  if (resolved.kind === 'candidates') {
    return err(
      ERROR_CODE.AMBIGUOUS,
      `Multiple companies match "${query}". Disambiguate by name or id.`,
      { candidates: resolved.companies.map(toCandidateDetail) },
    )
  }

  // Single match — load the full row to render the detail block.
  const id = resolved.company.id
  const fullRows = await db
    .select()
    .from(schema.orgCompanies)
    .where(
      and(
        eq(schema.orgCompanies.userId, userId),
        eq(schema.orgCompanies.id, id),
      ),
    )
    .limit(1)
  const c = fullRows[0]
  if (!c) {
    // Race: row deleted between resolver and detail fetch. Surface as
    // NOT_FOUND rather than INTERNAL — semantically that's what it is.
    return err(ERROR_CODE.NOT_FOUND, `Company "${query}" was just deleted.`)
  }

  // Co-investors: names from the synced company_investors join (the legacy
  // org_companies.co_investors column was dropped). Ordered by position.
  // Mirrors the GET /companies/:id detail handler in routes/companies.ts.
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

  return ok(renderCompanyMarkdown(c, coInvestors), cyggieUrl('company', c.id))
}

function toCandidateDetail(c: CompanyCandidate): {
  id: string
  name: string
  industry: string | null
  pipelineStage: string | null
  lastTouched: string | null
} {
  return {
    id: c.id,
    name: c.canonicalName,
    industry: c.industry,
    pipelineStage: c.pipelineStage,
    lastTouched: formatRecency(c.lastTouchedAt),
  }
}

function renderCompanyMarkdown(
  c: typeof schema.orgCompanies.$inferSelect,
  coInvestors: string[] | null,
): string {
  const sections: string[] = []

  // Header
  const domainBit = c.primaryDomain ? ` _(${c.primaryDomain})_` : ''
  sections.push(`# ${c.canonicalName}${domainBit}`)

  // Top metadata block
  const meta = labeledLines([
    ['Industry', c.industry],
    ['Stage', c.stage],
    ['Pipeline', c.pipelineStage],
    ['Status', c.status],
    ['HQ', joinLoc(c.city, c.state)],
    ['Founded', c.foundingYear ? String(c.foundingYear) : null],
    ['Employees', c.employeeCountRange],
  ])
  if (meta) sections.push(meta)

  if (c.description) sections.push(c.description)

  // Funding section — only render if at least one field is set.
  const fundingLine = formatFundingLine({
    totalFundingRaised: c.totalFundingRaised,
    round: c.round,
    raiseSize: c.raiseSize,
    lastFundingDate: c.lastFundingDate,
    leadInvestor: c.leadInvestor,
    coInvestors,
  })
  const totalRaised = formatUSD(c.totalFundingRaised)
  const arr = formatUSD(c.arr)
  const burn = formatUSD(c.burnRate)
  const valuation = formatUSD(c.postMoneyValuation)
  const financialLines = labeledLines([
    ['Latest round', fundingLine],
    ['Total raised', totalRaised],
    ['Post-money valuation', valuation],
    ['ARR', arr],
    ['Burn rate (monthly)', burn],
    ['Runway (months)', c.runwayMonths !== null ? String(c.runwayMonths) : null],
  ])
  if (financialLines) {
    sections.push(`## Financials\n${financialLines}`)
  }

  // Deal flow
  const dealLines = labeledLines([
    ['Owner', c.relationshipOwner],
    ['Source', c.dealSource],
    ['Warm intro via', c.warmIntroSource],
    ['Next follow-up', formatDate(c.nextFollowupDate)],
  ])
  if (dealLines) {
    sections.push(`## Deal flow\n${dealLines}`)
  }

  // AI key takeaways — pinned user note first (if any), then AI summary.
  // Renders both so the LLM can see "user said X but AI summary says Y".
  if (c.keyTakeawaysUserNote || c.keyTakeaways) {
    const parts: string[] = ['## Key takeaways']
    if (c.keyTakeawaysUserNote) {
      parts.push(`**User note:** ${c.keyTakeawaysUserNote}`)
    }
    if (c.keyTakeaways) {
      parts.push(c.keyTakeaways)
    }
    sections.push(parts.join('\n\n'))
  }

  // Footer link
  sections.push(`---\n[View in Cyggie](${cyggieUrl('company', c.id)})`)

  return sections.join('\n\n')
}

function joinLoc(city: string | null, state: string | null): string | null {
  const bits = [city, state].filter((b): b is string => !!b)
  return bits.length > 0 ? bits.join(', ') : null
}
