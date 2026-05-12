import { describe, it, expect } from 'vitest'
import { runsReducer, TERMINAL_CAPS, type RunsState } from '../renderer/contexts/RunsContext'
import type { AgentEvent } from '../shared/types/agent-events'

function withStartedRun(): RunsState {
  return runsReducer(
    { runs: new Map() },
    { type: 'started', runId: 'r1', kind: 'thesis_stress_test', companyId: 'c1', ts: 1 },
  )
}

function capEvent(cap: 'web_searches' | 'iterations' | 'input_tokens' | 'output_tokens'): AgentEvent {
  return { type: 'cap_exceeded', runId: 'r1', cap, limit: 5, used: 5 }
}

describe('RunsContext reducer — cap_exceeded discrimination', () => {
  it('web_searches cap keeps status="running" (spinner stays alive)', () => {
    const after = runsReducer(withStartedRun(), { type: 'event', event: capEvent('web_searches'), ts: 2 })
    const run = after.runs.get('r1')!
    expect(run.status).toBe('running')
    expect(run.errorMessage).toContain('web_searches cap reached')
  })

  it('iterations cap transitions status="cap_exceeded" (spinner stops)', () => {
    const after = runsReducer(withStartedRun(), { type: 'event', event: capEvent('iterations'), ts: 2 })
    expect(after.runs.get('r1')!.status).toBe('cap_exceeded')
  })

  it('input_tokens cap transitions status="cap_exceeded"', () => {
    const after = runsReducer(withStartedRun(), { type: 'event', event: capEvent('input_tokens'), ts: 2 })
    expect(after.runs.get('r1')!.status).toBe('cap_exceeded')
  })

  it('output_tokens cap transitions status="cap_exceeded"', () => {
    const after = runsReducer(withStartedRun(), { type: 'event', event: capEvent('output_tokens'), ts: 2 })
    expect(after.runs.get('r1')!.status).toBe('cap_exceeded')
  })

  it('errorMessage is set on ALL cap_exceeded events (terminal or not)', () => {
    for (const cap of ['web_searches', 'iterations', 'input_tokens', 'output_tokens'] as const) {
      const after = runsReducer(withStartedRun(), { type: 'event', event: capEvent(cap), ts: 2 })
      const run = after.runs.get('r1')!
      expect(run.errorMessage).toContain(`${cap} cap reached`)
    }
  })

  it('TERMINAL_CAPS set has exactly the three terminal caps', () => {
    expect(TERMINAL_CAPS.has('iterations')).toBe(true)
    expect(TERMINAL_CAPS.has('input_tokens')).toBe(true)
    expect(TERMINAL_CAPS.has('output_tokens')).toBe(true)
    expect(TERMINAL_CAPS.has('web_searches')).toBe(false)
  })

  it('done event after web_searches cap still transitions to success', () => {
    // Realistic flow: web_searches cap → agent finishes → done event arrives.
    const afterCap = runsReducer(withStartedRun(), { type: 'event', event: capEvent('web_searches'), ts: 2 })
    const afterDone = runsReducer(afterCap, {
      type: 'event',
      ts: 3,
      event: {
        type: 'done',
        runId: 'r1',
        versionId: 'report-abc',
        durationMs: 12_000,
        inputTokens: 5000,
        outputTokens: 800,
        costEstimateUsd: 0.35,
        toolCallCount: 22,
      },
    })
    const run = afterDone.runs.get('r1')!
    expect(run.status).toBe('success')
    expect(run.versionId).toBe('report-abc')
  })
})
