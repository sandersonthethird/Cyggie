/**
 * Tests for dashboard filter SQL builders.
 *
 * buildCompanyExistsClause / buildCompanyConditions / buildNoteWhereClause are pure
 * functions — no DB required.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCompanyExistsClause,
  buildCompanyConditions,
  buildNoteWhereClause,
} from '@cyggie/db/sqlite/repositories/dashboard.repo'

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

  it("treats 'none' as a null/empty pipeline_stage match", () => {
    const result = buildCompanyExistsClause(
      ['none'],
      null,
      'meeting_company_links',
      'meeting_id',
      'm'
    )
    expect(result).toContain('oc.pipeline_stage IS NULL')
    expect(result).toContain("oc.pipeline_stage = ''")
    expect(result).not.toContain('oc.pipeline_stage IN')
  })
})

describe('buildCompanyConditions', () => {
  it('returns empty string when no filter is active', () => {
    expect(buildCompanyConditions(null, null)).toBe('')
    expect(buildCompanyConditions([], [])).toBe('')
  })

  it("ORs a real stage together with 'none' inside the stage group", () => {
    const result = buildCompanyConditions(['screening', 'none'], null)
    expect(result).toContain("oc.pipeline_stage IN ('screening')")
    expect(result).toContain('oc.pipeline_stage IS NULL')
    expect(result).toContain("oc.pipeline_stage = ''")
    // stage variants are grouped and OR'd
    expect(result).toMatch(/\(oc\.pipeline_stage IN \('screening'\) OR oc\.pipeline_stage IS NULL OR oc\.pipeline_stage = ''\)/)
  })

  it('ORs the stage group with the entity-type clause', () => {
    const result = buildCompanyConditions(['diligence'], ['portfolio'])
    expect(result).toContain("oc.pipeline_stage IN ('diligence')")
    expect(result).toContain("oc.entity_type IN ('portfolio')")
    expect(result).toMatch(/ OR oc\.entity_type IN/)
  })
})

describe('buildNoteWhereClause', () => {
  it('returns empty string when no company filter is active (all notes show)', () => {
    expect(buildNoteWhereClause(null, null)).toBe('')
    expect(buildNoteWhereClause([], [])).toBe('')
  })

  it('matches tagged notes via company_id and excludes untagged when None not selected', () => {
    const result = buildNoteWhereClause(['screening'], null)
    expect(result.trim()).toMatch(/^WHERE/)
    expect(result).toContain('n.company_id IS NOT NULL')
    expect(result).toContain('SELECT 1 FROM org_companies oc WHERE oc.id = n.company_id')
    expect(result).toContain("oc.pipeline_stage IN ('screening')")
    // untagged notes are NOT included unless None is selected
    expect(result).not.toContain('n.company_id IS NULL')
  })

  it("includes untagged notes when 'none' stage is selected", () => {
    const result = buildNoteWhereClause(['screening', 'none'], null)
    expect(result).toContain('n.company_id IS NULL')
    expect(result).toContain('n.company_id IS NOT NULL')
  })

  it('includes untagged notes when only an entity-type filter is set (no stage filter)', () => {
    const result = buildNoteWhereClause(null, ['portfolio'])
    expect(result).toContain("oc.entity_type IN ('portfolio')")
    expect(result).toContain('n.company_id IS NULL')
  })
})
