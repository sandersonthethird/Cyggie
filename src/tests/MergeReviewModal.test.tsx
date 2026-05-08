/**
 * @vitest-environment jsdom
 *
 * Tests for MergeReviewModal — per-pair conflict picker UI.
 *
 * Covered branches:
 *   No conflicts + no auto-fill         → simplified confirm message
 *   Conflicts present                   → diff table with target/source radios
 *     ├ Target is the default selection
 *     └ Toggling source updates the override sent on confirm
 *   Auto-fill present                   → collapsed accordion
 *     ├ Defaults to taking source value (no override sent)
 *     └ Toggling 'drop' sends an explicit null override
 *   IPC failure on preview              → error block visible, no confirm
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { IPC_CHANNELS } from '../shared/constants/channels'
import type { CompanyMergePreview } from '../shared/types/company'

// CSS module → identity proxy
vi.mock('../renderer/components/company/MergeReviewModal.module.css', () => ({
  default: new Proxy({}, { get: (_: object, prop: string) => prop })
}))

// api.invoke mock — assigned per-test
const invokeMock = vi.fn()
vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) }
}))

import { MergeReviewModal } from '../renderer/components/company/MergeReviewModal'

const baseProps = {
  open: true,
  targetId: 't1',
  sourceId: 's1',
  onCancel: vi.fn(),
  onSuccess: vi.fn()
}

function makePreview(overrides: Partial<CompanyMergePreview> = {}): CompanyMergePreview {
  return {
    target: { id: 't1', canonicalName: 'TargetCo' },
    source: { id: 's1', canonicalName: 'SourceCo' },
    conflicts: [],
    autoFill: [],
    arrayUnions: [],
    ...overrides
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  baseProps.onCancel = vi.fn()
  baseProps.onSuccess = vi.fn()
})
afterEach(() => cleanup())

describe('MergeReviewModal', () => {
  it('renders the simplified confirm when there are no conflicts and no auto-fill', async () => {
    invokeMock.mockResolvedValueOnce(makePreview())

    render(<MergeReviewModal {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByText(/No field conflicts/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders conflict rows with target as the default radio and surfaces both values', async () => {
    invokeMock.mockResolvedValueOnce(makePreview({
      conflicts: [
        { column: 'description', label: 'Description', targetValue: 'T desc', sourceValue: 'S desc' },
        { column: 'city',        label: 'City',        targetValue: 'NYC',    sourceValue: 'SF'     }
      ]
    }))

    render(<MergeReviewModal {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByText('Description')).toBeInTheDocument()
    })
    expect(screen.getByText('T desc')).toBeInTheDocument()
    expect(screen.getByText('S desc')).toBeInTheDocument()
    expect(screen.getByText('NYC')).toBeInTheDocument()
    expect(screen.getByText('SF')).toBeInTheDocument()

    // Both rows default to "target" — that means the source-side radios are
    // unchecked. We assert via the radio elements directly.
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    // Two pairs of radios → 4 total. Even-indexed are target, odd are source.
    expect(radios[0].checked).toBe(true)   // description target
    expect(radios[1].checked).toBe(false)  // description source
    expect(radios[2].checked).toBe(true)   // city target
    expect(radios[3].checked).toBe(false)  // city source
  })

  it('confirms with no overrides when user keeps all targets', async () => {
    invokeMock.mockResolvedValueOnce(makePreview({
      conflicts: [
        { column: 'description', label: 'Description', targetValue: 'T desc', sourceValue: 'S desc' }
      ]
    }))
    invokeMock.mockResolvedValueOnce({ targetCompanyId: 't1', sourceCompanyId: 's1', relinked: {} })

    render(<MergeReviewModal {...baseProps} />)
    await waitFor(() => screen.getByText('Description'))

    fireEvent.click(screen.getByText(/Apply merge/i))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.COMPANY_MERGE, 't1', 's1', {})
    })
    expect(baseProps.onSuccess).toHaveBeenCalledWith('t1')
  })

  it('confirms with source override when user picks source side', async () => {
    invokeMock.mockResolvedValueOnce(makePreview({
      conflicts: [
        { column: 'description', label: 'Description', targetValue: 'T desc', sourceValue: 'S desc' }
      ]
    }))
    invokeMock.mockResolvedValueOnce({ targetCompanyId: 't1', sourceCompanyId: 's1', relinked: {} })

    render(<MergeReviewModal {...baseProps} />)
    await waitFor(() => screen.getByText('Description'))

    // Click the second radio (source side) for the description row.
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    fireEvent.click(radios[1])

    fireEvent.click(screen.getByText(/Apply merge/i))

    await waitFor(() => {
      const mergeCall = invokeMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.COMPANY_MERGE)
      expect(mergeCall).toBeDefined()
      expect(mergeCall![3]).toEqual({ description: 'S desc' })
    })
  })

  it('renders auto-fill accordion (collapsed by default) and applies source values silently', async () => {
    invokeMock.mockResolvedValueOnce(makePreview({
      autoFill: [
        { column: 'city',     label: 'City',          targetValue: null, sourceValue: 'SF' },
        { column: 'industry', label: 'Industry',      targetValue: null, sourceValue: 'fintech' }
      ]
    }))
    invokeMock.mockResolvedValueOnce({ targetCompanyId: 't1', sourceCompanyId: 's1', relinked: {} })

    render(<MergeReviewModal {...baseProps} />)
    await waitFor(() => screen.getByText(/auto-fill from source/i))

    // Collapsed by default: rows should not be in the DOM yet.
    expect(screen.queryByText('City')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/auto-fill from source/i))

    expect(screen.getByText('City')).toBeInTheDocument()
    expect(screen.getByText('SF')).toBeInTheDocument()
    expect(screen.getByText('fintech')).toBeInTheDocument()

    // Confirm without changing anything → backend handles auto-fill, no overrides sent.
    fireEvent.click(screen.getByText(/Apply merge/i))
    await waitFor(() => {
      const mergeCall = invokeMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.COMPANY_MERGE)
      expect(mergeCall).toBeDefined()
      expect(mergeCall![3]).toEqual({})
    })
  })

  it('sends explicit null override when user opts to drop an auto-fill field', async () => {
    invokeMock.mockResolvedValueOnce(makePreview({
      autoFill: [
        { column: 'city', label: 'City', targetValue: null, sourceValue: 'SF' }
      ]
    }))
    invokeMock.mockResolvedValueOnce({ targetCompanyId: 't1', sourceCompanyId: 's1', relinked: {} })

    render(<MergeReviewModal {...baseProps} />)
    await waitFor(() => screen.getByText(/auto-fill from source/i))
    fireEvent.click(screen.getByText(/auto-fill from source/i))

    // Click the 'Drop' radio for City (the second radio in the autofill row).
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    // First radio is "take source"; second is "drop" (per the modal layout).
    fireEvent.click(radios[1])

    fireEvent.click(screen.getByText(/Apply merge/i))
    await waitFor(() => {
      const mergeCall = invokeMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.COMPANY_MERGE)
      expect(mergeCall).toBeDefined()
      expect(mergeCall![3]).toEqual({ city: null })
    })
  })

  it('shows an error message and does not call onSuccess when the preview IPC fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom — preview failed'))

    render(<MergeReviewModal {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom — preview failed')
    })
    expect(baseProps.onSuccess).not.toHaveBeenCalled()
  })

  it('returns null when open=false', () => {
    render(<MergeReviewModal {...baseProps} open={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
