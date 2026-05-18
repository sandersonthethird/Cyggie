import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the exa-research module so web_search/web_fetch don't hit the network.
vi.mock('@cyggie/services/exa-research', () => ({
  agentWebSearch: vi.fn(),
  agentWebFetch: vi.fn(),
}))

// Mock company repo + flagged files so internal tools don't hit the DB.
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  listCompanyMeetings: vi.fn(() => []),
}))
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () => ({
  getFlaggedFiles: vi.fn(() => []),
}))
vi.mock('../main/storage/file-manager', () => ({
  readLocalFile: vi.fn(() => Promise.resolve('')),
}))
// Connection is touched transitively; provide a noop fake.
vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  }),
}))

import {
  buildMemoProducerTools,
  EVIDENCE_BUFFER_CAP,
  type MemoProducerRunState,
} from '@cyggie/services/llm/agents/memo-producer-tools'
import { MEMO_SECTIONS, type MemoSectionHeading } from '@cyggie/services/llm/memo/sections'
import type { ToolContext } from '@cyggie/services/llm/agents/define-tool'
import * as exa from '@cyggie/services/exa-research'

const mockWebSearch = vi.mocked(exa.agentWebSearch)
const mockWebFetch = vi.mocked(exa.agentWebFetch)

function makeState(overrides: Partial<MemoProducerRunState> = {}): MemoProducerRunState {
  return {
    companyId: 'company-1',
    companyName: 'Acme',
    webFetchAllowlist: new Set(),
    evidenceBuffer: [],
    submittedSections: new Map(),
    sectionRoster: MEMO_SECTIONS,
    emit: vi.fn(),
    ...overrides,
  }
}

const ctx: ToolContext = {
  companyId: 'company-1',
  userId: 'user-1',
  runId: 'run-1',
  signal: new AbortController().signal,
}

function toolByName(state: MemoProducerRunState, name: string) {
  const tools = buildMemoProducerTools(state)
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool
}

describe('cite_source', () => {
  beforeEach(() => mockWebSearch.mockReset())

  it('buffers a valid evidence row, persisting section for the hover popover', async () => {
    const state = makeState()
    const tool = toolByName(state, 'cite_source')
    const result = await tool.dispatch(
      {
        section: 'Market / Industry',
        claimText: 'TAM is $50B',
        sourceType: 'web',
        sourceUrl: 'https://example.com/report',
        snippet: 'According to Gartner, the TAM is $50B in 2025.',
        confidence: 'high',
      },
      ctx,
    )
    expect(result.errorClass).toBeUndefined()
    expect(state.evidenceBuffer).toHaveLength(1)
    expect(state.evidenceBuffer[0].claimText).toBe('TAM is $50B')
    // Regression guard: pre-migration-090, the section field was validated by
    // the tool but dropped before insert. After migration 090 + the producer
    // tool plumbing change, section MUST persist on the buffered EvidenceRow
    // so the section hover popover (Delight #1) can attribute the row.
    expect(state.evidenceBuffer[0].section).toBe('Market / Industry')
  })

  it('rejects unknown section heading', async () => {
    const state = makeState()
    const tool = toolByName(state, 'cite_source')
    const result = await tool.dispatch(
      {
        section: 'Not A Real Section',
        claimText: 'x',
        sourceType: 'web',
        sourceUrl: 'https://example.com/x',
        snippet: 'snippet',
        confidence: 'high',
      },
      ctx,
    )
    expect((result.output as { error?: string }).error).toBe('invalid_section')
    expect(state.evidenceBuffer).toHaveLength(0)
  })

  it('rejects web source without sourceUrl', async () => {
    const state = makeState()
    const tool = toolByName(state, 'cite_source')
    const result = await tool.dispatch(
      {
        section: 'Competition',
        claimText: 'x',
        sourceType: 'web',
        snippet: 'snippet',
        confidence: 'medium',
      },
      ctx,
    )
    expect((result.output as { error?: string }).error).toContain('web evidence requires a sourceUrl')
    expect(state.evidenceBuffer).toHaveLength(0)
  })

  it('rejects internal source without sourceId', async () => {
    const state = makeState()
    const tool = toolByName(state, 'cite_source')
    const result = await tool.dispatch(
      {
        section: 'Team',
        claimText: 'x',
        sourceType: 'meeting',
        snippet: 'snippet',
        confidence: 'medium',
      },
      ctx,
    )
    expect((result.output as { error?: string }).error).toContain('meeting evidence requires a sourceId')
    expect(state.evidenceBuffer).toHaveLength(0)
  })

  it('rejects malformed source_url (non-http)', async () => {
    const state = makeState()
    const tool = toolByName(state, 'cite_source')
    // file:// is rejected by canonicalizeUrl. Zod's z.string().url() also
    // accepts only valid URL syntax — but our additional canonicalize-based
    // check is the defense-in-depth that catches non-http(s).
    const result = await tool.dispatch(
      {
        section: 'Team',
        claimText: 'x',
        sourceType: 'web',
        sourceUrl: 'file:///etc/passwd',
        snippet: 'snippet',
        confidence: 'low',
      },
      ctx,
    )
    expect((result.output as { error?: string }).error).toContain('sourceUrl is not a valid http(s) URL')
  })

  it('returns evidence_cap_reached when buffer is full', async () => {
    const state = makeState()
    // Pre-fill the buffer to the cap with valid rows.
    for (let i = 0; i < EVIDENCE_BUFFER_CAP; i++) {
      state.evidenceBuffer.push({
        claimText: `c${i}`,
        sourceType: 'web',
        sourceUrl: `https://x.com/${i}`,
        snippet: 's',
        confidence: 'low',
        isCritique: false,
      })
    }
    const tool = toolByName(state, 'cite_source')
    const result = await tool.dispatch(
      {
        section: 'Risks',
        claimText: 'overflow',
        sourceType: 'web',
        sourceUrl: 'https://x.com/over',
        snippet: 's',
        confidence: 'low',
      },
      ctx,
    )
    expect((result.output as { code?: string }).code).toBe('evidence_cap_reached')
    expect(state.evidenceBuffer).toHaveLength(EVIDENCE_BUFFER_CAP) // not incremented
  })
})

describe('submit_section', () => {
  it('accepts a valid section body', async () => {
    const state = makeState()
    const tool = toolByName(state, 'submit_section')
    const result = await tool.dispatch(
      { heading: 'Business Description', body_markdown: '- The company does X.\n- It sells Y.' },
      ctx,
    )
    expect(result.errorClass).toBeUndefined()
    expect(state.submittedSections.has('Business Description')).toBe(true)
    expect(state.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'section_completed', heading: 'Business Description' }),
    )
  })

  it('rejects unknown heading', async () => {
    const state = makeState()
    const tool = toolByName(state, 'submit_section')
    const result = await tool.dispatch(
      { heading: 'Made Up', body_markdown: 'body' },
      ctx,
    )
    expect((result.output as { error?: string }).error).toBe('invalid_heading')
  })

  it('rejects a heading not in the run roster (e.g., Valuation filtered out)', async () => {
    // Simulate a Pre-Seed roster — Valuation is filtered out by the gate.
    const filteredRoster = MEMO_SECTIONS.filter((s) => s.heading !== 'Valuation')
    const state = makeState({ sectionRoster: filteredRoster })
    const tool = toolByName(state, 'submit_section')
    const result = await tool.dispatch(
      { heading: 'Valuation', body_markdown: 'body' },
      ctx,
    )
    expect((result.output as { error?: string }).error).toBe('section_not_in_run_roster')
  })

  it('rejects duplicate submission', async () => {
    const state = makeState()
    const tool = toolByName(state, 'submit_section')
    await tool.dispatch(
      { heading: 'Team', body_markdown: 'first body' },
      ctx,
    )
    const result = await tool.dispatch(
      { heading: 'Team', body_markdown: 'second body' },
      ctx,
    )
    expect((result.output as { error?: string }).error).toBe('section_already_submitted')
  })

  it('rejects body that starts with `## ` at column 0', async () => {
    const state = makeState()
    const tool = toolByName(state, 'submit_section')
    const result = await tool.dispatch(
      { heading: 'Risks', body_markdown: '## Risks\n- risk one' },
      ctx,
    )
    expect((result.output as { error?: string }).error).toBe('body_starts_with_h2')
  })

  it('allows `###` subheadings within the body', async () => {
    const state = makeState()
    const tool = toolByName(state, 'submit_section')
    const result = await tool.dispatch(
      { heading: 'Risks', body_markdown: '### Subsection\n- risk one' },
      ctx,
    )
    expect(result.errorClass).toBeUndefined()
    expect(state.submittedSections.has('Risks')).toBe(true)
  })
})

describe('done', () => {
  it('returns ok when every required section has been submitted', async () => {
    const state = makeState()
    // Submit every required section.
    for (const s of MEMO_SECTIONS) {
      if (!s.required) continue
      state.submittedSections.set(s.heading, { body: 'body', submittedAt: Date.now() })
    }
    const tool = toolByName(state, 'done')
    const result = await tool.dispatch({}, ctx)
    expect(result.errorClass).toBeUndefined()
    expect((result.output as { ok?: boolean }).ok).toBe(true)
  })

  it('lists missing required sections', async () => {
    const state = makeState()
    // Submit a few but not all required.
    state.submittedSections.set('Business Description', { body: 'b', submittedAt: 0 })
    state.submittedSections.set('Team', { body: 'b', submittedAt: 0 })
    const tool = toolByName(state, 'done')
    const result = await tool.dispatch({}, ctx)
    const out = result.output as { error?: string; missing?: string[] }
    expect(out.error).toBe('required_sections_missing')
    expect(out.missing).toContain('Risks')
    expect(out.missing).toContain('Executive Summary')
  })

  it('does not require optional sections (Investment Thesis, Valuation, References)', async () => {
    // Filter to a roster that excludes ALL optional sections.
    const requiredOnly = MEMO_SECTIONS.filter((s) => s.required)
    const state = makeState({ sectionRoster: requiredOnly })
    for (const s of requiredOnly) {
      state.submittedSections.set(s.heading as MemoSectionHeading, { body: 'b', submittedAt: 0 })
    }
    const tool = toolByName(state, 'done')
    const result = await tool.dispatch({}, ctx)
    expect((result.output as { ok?: boolean }).ok).toBe(true)
  })
})

describe('web_fetch (allowlist)', () => {
  beforeEach(() => {
    mockWebFetch.mockReset()
    mockWebSearch.mockReset()
  })

  it('rejects URL not in the per-run allowlist', async () => {
    const state = makeState()
    const tool = toolByName(state, 'web_fetch')
    const result = await tool.dispatch({ url: 'https://attacker.example/exfil' }, ctx)
    expect((result.output as { code?: string }).code).toBe('allowlist_denied')
    expect(mockWebFetch).not.toHaveBeenCalled()
  })

  it('accepts URL after canonical-match against the allowlist', async () => {
    const state = makeState()
    // Pre-seed allowlist with canonical form.
    state.webFetchAllowlist.add('https://example.com/path')
    mockWebFetch.mockResolvedValueOnce({ url: 'https://example.com/path', title: null, text: 'body', truncated: false })
    const tool = toolByName(state, 'web_fetch')
    // Caller passes a non-canonical variant: trailing slash + uppercase host.
    const result = await tool.dispatch({ url: 'https://EXAMPLE.com/path/' }, ctx)
    expect((result.output as { error?: string }).error).toBeUndefined()
    expect(mockWebFetch).toHaveBeenCalledOnce()
  })

  it('rejects malformed URL outright', async () => {
    const state = makeState()
    const tool = toolByName(state, 'web_fetch')
    // The Zod schema accepts strings shaped like a URL but our canonicalize
    // returns null for non-http(s); we surface 'invalid_url' or rely on Zod.
    const result = await tool.dispatch({ url: 'not-even-a-url' }, ctx)
    // The schema rejects with ZodError → errorClass set.
    expect(result.errorClass).toBe('ZodError')
  })

  it('web_search auto-populates the allowlist with result URLs', async () => {
    const state = makeState()
    mockWebSearch.mockResolvedValueOnce({
      query: 'test',
      results: [
        { url: 'https://Example.COM/A/', title: null, snippet: 's', publishedDate: null },
        { url: 'https://other.com/path', title: null, snippet: 's', publishedDate: null },
      ],
    })
    const tool = toolByName(state, 'web_search')
    await tool.dispatch({ query: 'market size 2025' }, ctx)
    // Canonical form (lowercased host, no trailing slash).
    expect(state.webFetchAllowlist.has('https://example.com/A')).toBe(true)
    expect(state.webFetchAllowlist.has('https://other.com/path')).toBe(true)
  })
})
