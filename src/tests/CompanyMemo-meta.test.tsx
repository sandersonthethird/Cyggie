// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import type { MemoGenerateMeta } from '../shared/types/company'

vi.mock('../renderer/components/company/CompanyMemo.module.css', () => ({
  default: { sourcesFooter: 'sourcesFooter' },
}))

const { SourcesUsedFooter, buildSourcesUsedSentence, emptyResearchToastOptions } =
  await import('../renderer/components/company/CompanyMemo')

afterEach(() => cleanup())

const FULL_META: MemoGenerateMeta = {
  meetingCount: 6,
  summaryCount: 5,
  transcriptCount: 1,
  companyNoteCount: 8,
  contactNoteCount: 4,
  contactKeyTakeawayCount: 2,
  fileCount: 3,
  emailCount: 28,
  externalResearchQueryCount: 5,
  externalResearchResultCount: 12,
}

const EMPTY_META: MemoGenerateMeta = {
  meetingCount: 0,
  summaryCount: 0,
  transcriptCount: 0,
  companyNoteCount: 0,
  contactNoteCount: 0,
  contactKeyTakeawayCount: 0,
  fileCount: 0,
  emailCount: 0,
  externalResearchQueryCount: 0,
  externalResearchResultCount: 0,
}

/**
 * Tests for the two pure helpers extracted from CompanyMemo.tsx:
 *   - buildSourcesUsedSentence(meta) — formats the "Based on…" footer text
 *   - emptyResearchToastOptions(meta) — decides whether to fire the toast
 *
 * Plus an RTL render test for the SourcesUsedFooter component itself.
 *
 * The full CompanyMemo component is too dependency-heavy (TipTap + IPC +
 * RunsContext + 20 imports) to render meaningfully in a unit test. By
 * extracting the new behavior into pure helpers, we get tight test coverage
 * of the user-visible logic without setting up a render harness.
 */

describe('buildSourcesUsedSentence', () => {
  it('formats all categories with proper plurals when full meta', () => {
    const sentence = buildSourcesUsedSentence(FULL_META)
    expect(sentence).toBe('Based on 6 meetings, 12 notes (4 contact-tagged), 3 files, 28 emails, 5 web searches.')
  })

  it('uses singular forms for count=1', () => {
    const sentence = buildSourcesUsedSentence({
      ...EMPTY_META,
      meetingCount: 1,
      companyNoteCount: 1,
      fileCount: 1,
      emailCount: 1,
      externalResearchQueryCount: 1,
    })
    expect(sentence).toBe('Based on 1 meeting, 1 note, 1 file, 1 email, 1 web search.')
  })

  it('omits the contact-tagged breakdown when contactNoteCount is 0', () => {
    const sentence = buildSourcesUsedSentence({
      ...EMPTY_META,
      companyNoteCount: 5,
      contactNoteCount: 0,
    })
    expect(sentence).toBe('Based on 5 notes.')
  })

  it('totals notes (company + contact) into a single bucket', () => {
    const sentence = buildSourcesUsedSentence({
      ...EMPTY_META,
      companyNoteCount: 3,
      contactNoteCount: 2,
    })
    expect(sentence).toBe('Based on 5 notes (2 contact-tagged).')
  })

  it('skips zero-count categories entirely', () => {
    const sentence = buildSourcesUsedSentence({
      ...EMPTY_META,
      meetingCount: 2,
      // everything else 0
    })
    expect(sentence).toBe('Based on 2 meetings.')
  })

  it('returns null when all counts are zero', () => {
    expect(buildSourcesUsedSentence(EMPTY_META)).toBeNull()
  })
})

describe('emptyResearchToastOptions', () => {
  it('returns toast options when externalResearchQueryCount === 0', () => {
    const opts = emptyResearchToastOptions(EMPTY_META)
    expect(opts).toEqual({
      variant: 'success',
      title: 'Memo generated',
      message: expect.stringContaining('Skipped web research'),
    })
  })

  it('returns null when externalResearchQueryCount > 0', () => {
    expect(emptyResearchToastOptions(FULL_META)).toBeNull()
  })

  it('returns null when meta is null/undefined (back-compat with old main bundle)', () => {
    expect(emptyResearchToastOptions(null)).toBeNull()
    expect(emptyResearchToastOptions(undefined)).toBeNull()
  })

  it('still fires the toast when other counts are non-zero but query count is 0', () => {
    // Edge case: company has internal data but pre-research returned no queries
    // (e.g. no industry, no description, no nicheSignal, no founders).
    const meta: MemoGenerateMeta = {
      ...FULL_META,
      externalResearchQueryCount: 0,
      externalResearchResultCount: 0,
    }
    expect(emptyResearchToastOptions(meta)).not.toBeNull()
  })
})

describe('SourcesUsedFooter (RTL)', () => {
  it('renders the formatted sentence when meta has counts', () => {
    const { getByRole } = render(<SourcesUsedFooter meta={FULL_META} />)
    const footer = getByRole('note')
    expect(footer.textContent).toBe('Based on 6 meetings, 12 notes (4 contact-tagged), 3 files, 28 emails, 5 web searches.')
  })

  it('has the aria-label for accessibility', () => {
    const { getByRole } = render(<SourcesUsedFooter meta={FULL_META} />)
    expect(getByRole('note').getAttribute('aria-label')).toBe('Sources used to generate this memo')
  })

  it('renders null (nothing) when meta is all zeros', () => {
    const { container } = render(<SourcesUsedFooter meta={EMPTY_META} />)
    expect(container.firstChild).toBeNull()
  })

  it('updates text reactively when meta prop changes', () => {
    const { rerender, getByRole } = render(<SourcesUsedFooter meta={FULL_META} />)
    rerender(
      <SourcesUsedFooter
        meta={{ ...EMPTY_META, meetingCount: 1, externalResearchQueryCount: 0 }}
      />
    )
    expect(getByRole('note').textContent).toBe('Based on 1 meeting.')
  })
})
