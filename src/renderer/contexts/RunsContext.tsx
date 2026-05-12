/**
 * App-level registry of in-flight agent runs.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Why a global context?                                           │
 *   │                                                                 │
 *   │  An agent run takes ~30-60s. The user might navigate to another │
 *   │  company mid-run. If RunsContext is mounted at the app root,    │
 *   │  the run survives navigation, the AgentEvent stream keeps        │
 *   │  flowing, and we can surface a completion toast no matter what  │
 *   │  view the user is on.                                            │
 *   │                                                                 │
 *   │  The context also enforces a 5-minute "stuck-state watchdog":   │
 *   │  if no event arrives for 5min on a still-running run, we mark   │
 *   │  it as `stuck` and the UI surfaces an "I think it's done"        │
 *   │  recovery button (review decision #22). Without this, an IPC    │
 *   │  drop would leave the spinner spinning forever.                 │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Subscribers:
 *   - CompanyMemo: per-company in-flight gate (disable Stress-test
 *     button while a run for THIS company is active)
 *   - ResearchLog: streams the events for a specific runId
 *   - Top-level toast: shows a "Stress-test complete for {Company}"
 *     toast when the user is on a different company
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { AgentEvent } from '../../shared/types/agent-events'
import { api } from '../api'

export interface RunRecord {
  runId: string
  kind: string
  companyId: string
  status: 'running' | 'success' | 'failed' | 'aborted' | 'cap_exceeded' | 'stuck'
  startedAt: number
  lastEventAt: number
  events: AgentEvent[]
  /** Set when type==='done' arrives. */
  versionId?: string
  /** Set when type==='error' or 'cap_exceeded' arrives. */
  errorMessage?: string
}

export interface RunsState {
  runs: Map<string, RunRecord>
}
type State = RunsState

/**
 * Caps that TERMINATE the agent-loop. web_searches is intentionally absent:
 * the loop emits `cap_exceeded` for it but continues iterating (the cap-rejection
 * tool_result tells the model to wrap up). See agent-loop.ts cap handling.
 */
export const TERMINAL_CAPS = new Set<string>(['iterations', 'input_tokens', 'output_tokens'])

export type RunsAction =
  | { type: 'started'; runId: string; kind: string; companyId: string; ts: number }
  | { type: 'event'; event: AgentEvent; ts: number }
  | { type: 'mark_stuck'; runId: string }
  | { type: 'dismiss'; runId: string }

export function runsReducer(state: State, action: RunsAction): State {
  switch (action.type) {
    case 'started': {
      const runs = new Map(state.runs)
      runs.set(action.runId, {
        runId: action.runId,
        kind: action.kind,
        companyId: action.companyId,
        status: 'running',
        startedAt: action.ts,
        lastEventAt: action.ts,
        events: [],
      })
      return { runs }
    }
    case 'event': {
      const runs = new Map(state.runs)
      const run = runs.get(action.event.runId)
      if (!run) return state                       // event for a run we don't track
      const events = [...run.events, action.event]
      let status: RunRecord['status'] = run.status
      let versionId = run.versionId
      let errorMessage = run.errorMessage
      switch (action.event.type) {
        case 'done':
          status = 'success'
          versionId = action.event.versionId
          break
        case 'error':
          status = 'failed'
          errorMessage = action.event.message
          break
        case 'aborted':
          status = 'aborted'
          break
        case 'cap_exceeded':
          // Only TERMINAL caps end the run. The agent-loop calls finalize()
          // for iterations / input_tokens / output_tokens caps and continues
          // on web_searches (it just rejects further search calls). Mirror
          // that here so the Stress-test button's spinner stays alive while
          // the agent wraps up after a non-terminal cap.
          if (TERMINAL_CAPS.has(action.event.cap)) {
            status = 'cap_exceeded'
          }
          errorMessage = `${action.event.cap} cap reached (${action.event.used}/${action.event.limit})`
          break
      }
      runs.set(run.runId, {
        ...run,
        status,
        events,
        lastEventAt: action.ts,
        versionId,
        errorMessage,
      })
      return { runs }
    }
    case 'mark_stuck': {
      const runs = new Map(state.runs)
      const run = runs.get(action.runId)
      if (!run || run.status !== 'running') return state
      runs.set(run.runId, { ...run, status: 'stuck' })
      return { runs }
    }
    case 'dismiss': {
      const runs = new Map(state.runs)
      runs.delete(action.runId)
      return { runs }
    }
  }
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000   // 5 minutes per review decision #22
const WATCHDOG_INTERVAL_MS = 30 * 1000     // check every 30s

export interface RunsContextValue {
  runs: ReadonlyMap<string, RunRecord>
  startRun: (params: { runId: string; kind: string; companyId: string }) => void
  abortRun: (runId: string) => Promise<void>
  dismissRun: (runId: string) => void
  /** Mark a stuck run as resolved manually (the user clicked "I think it's done"). */
  recoverStuck: (runId: string) => void
  /** Subscribe to completion notifications anywhere in the app (toast surface). */
  onCompletion: (cb: (run: RunRecord) => void) => () => void
}

const RunsContext = createContext<RunsContextValue | null>(null)

export function RunsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(runsReducer, { runs: new Map<string, RunRecord>() })
  const completionHandlers = useRef(new Set<(run: RunRecord) => void>())
  const previousStatuses = useRef(new Map<string, RunRecord['status']>())

  // Subscribe to the IPC stream once. The handler dispatches all events; the
  // reducer routes by runId. Unsubscribe on unmount.
  useEffect(() => {
    const off = api.on(IPC_CHANNELS.THESIS_STRESS_TEST_PROGRESS, (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (!event || typeof event !== 'object' || !('type' in event)) return
      // 'started' event creates the run record
      if (event.type === 'started') {
        dispatch({ type: 'started', runId: event.runId, kind: event.kind, companyId: event.companyId, ts: Date.now() })
      } else {
        dispatch({ type: 'event', event, ts: Date.now() })
      }
    })
    return off
  }, [])

  // Stuck-state watchdog: every 30s, find running runs whose lastEventAt is
  // older than 5min and mark them stuck. The UI then surfaces a manual
  // recovery button. Without this, an IPC drop leaves the spinner spinning
  // forever (review decision #22).
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      for (const run of state.runs.values()) {
        if (run.status !== 'running') continue
        if (now - run.lastEventAt > STUCK_THRESHOLD_MS) {
          dispatch({ type: 'mark_stuck', runId: run.runId })
        }
      }
    }, WATCHDOG_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [state.runs])

  // Fire completion callbacks when a run transitions to a terminal status.
  // Top-level toast surface listens here.
  useEffect(() => {
    for (const run of state.runs.values()) {
      const prev = previousStatuses.current.get(run.runId)
      previousStatuses.current.set(run.runId, run.status)
      const isTerminal = run.status !== 'running' && run.status !== 'stuck'
      const wasRunning = prev === 'running' || prev === undefined
      if (isTerminal && wasRunning && prev !== run.status) {
        for (const cb of completionHandlers.current) cb(run)
      }
    }
  }, [state.runs])

  const startRun = useCallback((params: { runId: string; kind: string; companyId: string }) => {
    dispatch({ type: 'started', runId: params.runId, kind: params.kind, companyId: params.companyId, ts: Date.now() })
  }, [])

  const abortRun = useCallback(async (runId: string) => {
    await api.invoke(IPC_CHANNELS.THESIS_STRESS_TEST_ABORT, runId)
  }, [])

  const dismissRun = useCallback((runId: string) => {
    dispatch({ type: 'dismiss', runId })
  }, [])

  const recoverStuck = useCallback((runId: string) => {
    // Treat a manually-recovered stuck run as aborted from the UI's POV.
    // The main process may still finish later; if so, the agent_run row will
    // record the actual outcome and the user can re-open it from /dev/agent-runs.
    dispatch({ type: 'event', event: { type: 'aborted', runId }, ts: Date.now() })
  }, [])

  const onCompletion = useCallback((cb: (run: RunRecord) => void) => {
    completionHandlers.current.add(cb)
    return () => { completionHandlers.current.delete(cb) }
  }, [])

  const value = useMemo<RunsContextValue>(() => ({
    runs: state.runs,
    startRun,
    abortRun,
    dismissRun,
    recoverStuck,
    onCompletion,
  }), [state.runs, startRun, abortRun, dismissRun, recoverStuck, onCompletion])

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>
}

export function useRuns(): RunsContextValue {
  const ctx = useContext(RunsContext)
  if (!ctx) throw new Error('useRuns must be used within <RunsProvider>')
  return ctx
}

/**
 * Convenience hook: returns the most recent in-flight (or just-completed) run
 * for a specific (kind, companyId) pair. CompanyMemo uses this to gate the
 * Stress-test button per-company and to mount its ResearchLog.
 */
export function useRunForCompany(kind: string, companyId: string | null): RunRecord | null {
  const { runs } = useRuns()
  if (!companyId) return null
  let latest: RunRecord | null = null
  for (const run of runs.values()) {
    if (run.kind !== kind) continue
    if (run.companyId !== companyId) continue
    if (!latest || run.startedAt > latest.startedAt) latest = run
  }
  return latest
}
