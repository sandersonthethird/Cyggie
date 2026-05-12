// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import type { AgentEvent } from '../shared/types/agent-events'
import type { RunRecord } from '../renderer/contexts/RunsContext'

vi.mock('../renderer/components/company/ResearchLog.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

// Mock useRuns so the component can call dismissRun without a real provider.
const dismissRunMock = vi.fn()
vi.mock('../renderer/contexts/RunsContext', async () => {
  // Re-export the actual types but mock the hook.
  return {
    useRuns: () => ({ dismissRun: dismissRunMock }),
  }
})

const { ResearchLog } = await import('../renderer/components/company/ResearchLog')

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-123',
    kind: 'thesis_stress_test',
    companyId: 'co-1',
    status: 'running',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    events: [
      { type: 'started', runId: 'run-123', kind: 'thesis_stress_test', companyId: 'co-1', mode: 'stress_test', caps: { iterations: 12, webSearches: 5, inputTokens: 100_000 } } as AgentEvent,
      { type: 'iteration_start', runId: 'run-123', n: 1 } as AgentEvent,
      { type: 'cap_exceeded', runId: 'run-123', cap: 'web_searches', limit: 5, used: 5 } as AgentEvent,
      { type: 'iteration_start', runId: 'run-123', n: 2 } as AgentEvent,
    ],
    ...overrides,
  } as RunRecord
}

beforeEach(() => {
  dismissRunMock.mockClear()
})
afterEach(() => cleanup())

describe('ResearchLog — collapse + dismiss', () => {
  it('chevron toggles the event list visibility (collapse / expand)', () => {
    const { container, getByRole } = render(<ResearchLog run={makeRun()} />)
    // Expanded by default: at least one event-row class is present.
    expect(container.querySelectorAll('.row').length).toBeGreaterThan(0)
    // Collapse.
    fireEvent.click(getByRole('button', { name: /Collapse research log/ }))
    expect(container.querySelectorAll('.row').length).toBe(0)
    // Header stays — chevron button still in DOM.
    expect(getByRole('button', { name: /Expand research log/ })).toBeTruthy()
  })

  it('header dismiss button is HIDDEN while run is running', () => {
    const { queryByRole } = render(<ResearchLog run={makeRun({ status: 'running' })} />)
    expect(queryByRole('button', { name: /Dismiss research log/ })).toBeNull()
  })

  it('header dismiss button is VISIBLE when run is in a terminal state', () => {
    const { getByRole } = render(<ResearchLog run={makeRun({ status: 'success' })} />)
    expect(getByRole('button', { name: /Dismiss research log/ })).toBeTruthy()
  })

  it('clicking header dismiss calls dismissRun with the runId', () => {
    const { getByRole } = render(<ResearchLog run={makeRun({ status: 'cap_exceeded' })} />)
    fireEvent.click(getByRole('button', { name: /Dismiss research log/ }))
    expect(dismissRunMock).toHaveBeenCalledWith('run-123')
  })

  it('cap_exceeded row × button hides that row locally (does not call dismissRun)', () => {
    const { container, getAllByRole } = render(<ResearchLog run={makeRun()} />)
    // The "Dismiss this notice" button on the cap_exceeded row.
    const rowDismisses = getAllByRole('button', { name: /Dismiss this notice/ })
    expect(rowDismisses.length).toBe(1)
    // The cap row's label is visible before dismiss.
    expect(container.textContent).toContain('Cap reached')
    fireEvent.click(rowDismisses[0])
    // The cap row's label is gone after dismiss.
    expect(container.textContent).not.toContain('Cap reached')
    // dismissRun (the WHOLE log) was NOT called — this is a per-row local hide.
    expect(dismissRunMock).not.toHaveBeenCalled()
  })
})
