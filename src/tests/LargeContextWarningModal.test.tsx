// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import type { MemoPreflightResult } from '../shared/types/company'

vi.mock('../renderer/components/company/LargeContextWarningModal.module.css', () => ({
  default: {
    overlay: 'overlay', dialog: 'dialog', title: 'title', headline: 'headline',
    subhead: 'subhead', breakdown: 'breakdown', fileList: 'fileList',
    fileItem: 'fileItem', fileName: 'fileName', fileSize: 'fileSize',
    hint: 'hint', actions: 'actions', cancelBtn: 'cancelBtn', confirmBtn: 'confirmBtn',
  },
}))

const { default: LargeContextWarningModal } = await import(
  '../renderer/components/company/LargeContextWarningModal'
)

afterEach(() => cleanup())

const PREFLIGHT: MemoPreflightResult = {
  totalChars: 250_000,
  estTokens: 62_500,
  estCostUsd: 0.1875,
  willTriggerWarning: true,
  flaggedFileCount: 4,
  breakdown: {
    meetings: 40_000,
    notes: 30_000,
    emails: 20_000,
    files: 130_000,
    externalResearch: 18_000,
    contactProfiles: 1_600,
    other: 2_000,
  },
  fileBreakdown: [
    { name: 'small.txt', sizeBytes: 5_000, estChars: 5_000 },
    { name: 'huge-deck.pdf', sizeBytes: 2_000_000, estChars: 64_000 },
    { name: 'mid.docx', sizeBytes: 100_000, estChars: 40_000 },
    { name: 'tiny.md', sizeBytes: 1_000, estChars: 1_000 },
  ],
}

describe('LargeContextWarningModal', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <LargeContextWarningModal open={false} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when preflight is null', () => {
    const { container } = render(
      <LargeContextWarningModal open={true} preflight={null} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('formats tokens, cost, and file count in the headline', () => {
    const { getByText } = render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(getByText(/63k tokens/)).toBeTruthy()      // 62500 → 63k
    expect(getByText(/\$0\.19/)).toBeTruthy()          // 0.1875 → 0.19
    expect(getByText(/4 files/)).toBeTruthy()
    expect(getByText(/250k chars total/)).toBeTruthy()
  })

  it('renders the breakdown by source', () => {
    const { getByText, getAllByText } = render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(getByText(/Meetings:/)).toBeTruthy()
    // 40k appears for both meetings (breakdown) and mid.docx (file list)
    expect(getAllByText(/40k chars/).length).toBeGreaterThanOrEqual(1)
    expect(getByText(/Files:/)).toBeTruthy()
    expect(getByText(/130k chars/)).toBeTruthy()
  })

  it('omits zero-count breakdown entries', () => {
    const noEmailsPreflight = {
      ...PREFLIGHT,
      breakdown: { ...PREFLIGHT.breakdown, emails: 0 },
    }
    const { queryByText } = render(
      <LargeContextWarningModal open={true} preflight={noEmailsPreflight} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(queryByText(/Emails:/)).toBeNull()
  })

  it('sorts file list by estChars DESC', () => {
    render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={() => {}} />
    )
    // Modal is rendered via portal into document.body, not into RTL's container.
    const items = document.querySelectorAll('.fileItem')
    expect(items.length).toBe(4)
    expect(items[0]!.textContent).toContain('huge-deck.pdf')      // 64k - largest
    expect(items[1]!.textContent).toContain('mid.docx')            // 40k
    expect(items[2]!.textContent).toContain('small.txt')           // 5k
    expect(items[3]!.textContent).toContain('tiny.md')             // 1k
  })

  it('Continue button calls onConfirm', () => {
    const onConfirm = vi.fn()
    const { getByRole } = render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={onConfirm} onCancel={() => {}} />
    )
    fireEvent.click(getByRole('button', { name: /continue/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Cancel button calls onCancel', () => {
    const onCancel = vi.fn()
    const { getByRole } = render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.click(getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Esc key calls onCancel', () => {
    const onCancel = vi.fn()
    render(
      <LargeContextWarningModal open={true} preflight={PREFLIGHT} onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not render the file list section when fileBreakdown is empty', () => {
    const { queryByText } = render(
      <LargeContextWarningModal
        open={true}
        preflight={{ ...PREFLIGHT, fileBreakdown: [], flaggedFileCount: 0 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(queryByText(/Flagged files/)).toBeNull()
    expect(document.querySelectorAll('.fileItem').length).toBe(0)
  })

  it('rounds cost to 2 decimals (no floating-point noise)', () => {
    const { getByText } = render(
      <LargeContextWarningModal
        open={true}
        preflight={{ ...PREFLIGHT, estCostUsd: 0.4499999999 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(getByText(/\$0\.45/)).toBeTruthy()
  })
})
