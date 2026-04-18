/**
 * Tests for dashboard filter SQL builder.
 *
 * buildCompanyExistsClause is a pure function — no DB required.
 */

import { describe, it, expect } from 'vitest'
import { buildCompanyExistsClause } from '../main/database/repositories/dashboard.repo'

describe('buildCompanyExistsClause', () => {
  it('returns empty string when both filters are null', () => {
    const result = buildCompanyExistsClause(null, null, 'meeting_company_links', 'meeting_id', 'm')
    expect(result).toBe('')
  })

  it('returns empty string when both filters are empty arrays', () => {
    const result = buildCompanyExistsClause([], [], 'meeting_company_links', 'meeting_id', 'm')
    expect(result).toBe('')
  })

  it('builds pipeline_stage IN clause for stage-only filter', () => {
    const result = buildCompanyExistsClause(
      ['screening', 'diligence'],
      null,
      'meeting_company_links',
      'meeting_id',
      'm'
    )
    expect(result).toContain("oc.pipeline_stage IN ('screening', 'diligence')")
    expect(result).not.toContain('entity_type')
    expect(result).toContain('meeting_company_links')
    expect(result).toContain('lnk.meeting_id = m.id')
  })

  it('builds entity_type IN clause for entity-type-only filter', () => {
    const result = buildCompanyExistsClause(
      null,
      ['portfolio', 'lp'],
      'email_company_links',
      'message_id',
      'em'
    )
    expect(result).toContain("oc.entity_type IN ('portfolio', 'lp')")
    expect(result).not.toContain('pipeline_stage')
    expect(result).toContain('email_company_links')
    expect(result).toContain('lnk.message_id = em.id')
  })

  it('ORs pipeline_stage and entity_type conditions when both present', () => {
    const result = buildCompanyExistsClause(
      ['diligence'],
      ['portfolio'],
      'meeting_company_links',
      'meeting_id',
      'm'
    )
    expect(result).toContain("oc.pipeline_stage IN ('diligence')")
    expect(result).toContain("oc.entity_type IN ('portfolio')")
    // Conditions joined with OR
    const orMatch = result.match(/pipeline_stage.*OR.*entity_type|entity_type.*OR.*pipeline_stage/s)
    expect(orMatch).not.toBeNull()
  })

  it('wraps conditions in AND EXISTS block', () => {
    const result = buildCompanyExistsClause(
      ['screening'],
      null,
      'meeting_company_links',
      'meeting_id',
      'm'
    )
    expect(result.trim()).toMatch(/^AND EXISTS/)
    expect(result).toContain('SELECT 1 FROM meeting_company_links lnk')
    expect(result).toContain('JOIN org_companies oc ON oc.id = lnk.company_id')
  })
})
