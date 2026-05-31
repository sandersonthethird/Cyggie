/**
 * EnhancementContext — owns per-meeting summary-enhancement state above
 * the route boundary so it survives navigation.
 *
 * Why: MeetingDetail (`/meeting/:id`) is a full route that unmounts when
 * the user navigates away. Previously, all enhancement state (isGenerating,
 * streamedSummary, the awaited SUMMARY_GENERATE result, the proposal
 * modal) lived inside that component, so clicking away mid-run silently
 * dropped the completion modal — the macOS notification still fired
 * because it ran inside the promise closure, but every setState landed on
 * an unmounted component.
 *
 * This provider lives above HashRouter, subscribes once to the streaming
 * IPC channels, and stashes the final SummaryGenerateResult so the route
 * can consume it on (re-)mount via `consumePendingResult()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { SummaryGenerateResult } from '../../shared/types/summary'

interface PerMeetingState {
  inProgress: boolean
  phase: string
  streamedSummary: string
  /** Completed result waiting to be consumed by MeetingDetail. */
  pendingResult: SummaryGenerateResult | null
}

const EMPTY: PerMeetingState = {
  inProgress: false,
  phase: '',
  streamedSummary: '',
  pendingResult: null,
}

interface EnhancementContextValue {
  startEnhancement: (meetingId: string, templateId: string) => Promise<void>
  stopEnhancement: () => void
  consumePendingResult: (meetingId: string) => SummaryGenerateResult | null
  getState: (meetingId: string) => PerMeetingState
  subscribe: (meetingId: string, fn: () => void) => () => void
}

const EnhancementContext = createContext<EnhancementContextValue | null>(null)

export function EnhancementProvider({ children }: { children: ReactNode }) {
  const states = useRef<Map<string, PerMeetingState>>(new Map())
  const subscribers = useRef<Map<string, Set<() => void>>>(new Map())
  // Only one SUMMARY_GENERATE pipeline runs at a time in the main process
  // (SUMMARY_ABORT is global), so we route streaming events to whichever
  // meeting is currently in flight.
  const activeMeetingIdRef = useRef<string | null>(null)

  const notify = useCallback((meetingId: string) => {
    const set = subscribers.current.get(meetingId)
    if (!set) return
    for (const fn of set) fn()
  }, [])

  const setState = useCallback(
    (meetingId: string, partial: Partial<PerMeetingState>) => {
      const prev = states.current.get(meetingId) ?? EMPTY
      states.current.set(meetingId, { ...prev, ...partial })
      notify(meetingId)
    },
    [notify],
  )

  const getState = useCallback((meetingId: string): PerMeetingState => {
    return states.current.get(meetingId) ?? EMPTY
  }, [])

  const subscribe = useCallback((meetingId: string, fn: () => void) => {
    let set = subscribers.current.get(meetingId)
    if (!set) {
      set = new Set()
      subscribers.current.set(meetingId, set)
    }
    set.add(fn)
    return () => {
      const current = subscribers.current.get(meetingId)
      if (!current) return
      current.delete(fn)
      if (current.size === 0) subscribers.current.delete(meetingId)
    }
  }, [])

  // Subscribe once, for the lifetime of the provider. Streaming events
  // route to whatever meetingId is currently in flight.
  useEffect(() => {
    const unsubProgress = api.on(IPC_CHANNELS.SUMMARY_PROGRESS, (chunk: unknown) => {
      const id = activeMeetingIdRef.current
      if (!id) return
      const prev = states.current.get(id) ?? EMPTY
      const next = chunk === null
        ? { ...prev, streamedSummary: '' }
        : { ...prev, streamedSummary: prev.streamedSummary + String(chunk) }
      states.current.set(id, next)
      notify(id)
    })
    const unsubPhase = api.on(IPC_CHANNELS.SUMMARY_PHASE, (phase: unknown) => {
      const id = activeMeetingIdRef.current
      if (!id) return
      const prev = states.current.get(id) ?? EMPTY
      states.current.set(id, { ...prev, phase: String(phase) })
      notify(id)
    })
    return () => {
      unsubProgress()
      unsubPhase()
    }
  }, [notify])

  const startEnhancement = useCallback(
    async (meetingId: string, templateId: string) => {
      if (!meetingId || !templateId) return
      const existing = states.current.get(meetingId)
      if (existing?.inProgress) return

      activeMeetingIdRef.current = meetingId
      setState(meetingId, {
        inProgress: true,
        phase: '',
        streamedSummary: '',
        pendingResult: null,
      })

      let raw: SummaryGenerateResult | string | undefined
      try {
        raw = await api.invoke<SummaryGenerateResult | string>(
          IPC_CHANNELS.SUMMARY_GENERATE,
          meetingId,
          templateId,
        )
      } catch (err) {
        const errStr = String(err)
        if (!errStr.includes('abort') && !errStr.includes('Abort')) {
          console.error('Summary generation failed:', err)
        }
      } finally {
        if (activeMeetingIdRef.current === meetingId) {
          activeMeetingIdRef.current = null
        }
      }

      if (raw === undefined) {
        // Aborted or errored — clear in-progress, no pending result.
        setState(meetingId, {
          inProgress: false,
          phase: '',
          streamedSummary: '',
        })
        return
      }

      const result: SummaryGenerateResult =
        typeof raw === 'string'
          ? {
              summary: raw,
              companyUpdateProposals: [],
              contactUpdateProposals: [],
            }
          : raw

      const companyUpdateProposals = result.companyUpdateProposals || []
      const contactUpdateProposals = result.contactUpdateProposals || []
      const totalFieldCount =
        companyUpdateProposals.reduce(
          (n, p) => n + p.changes.length + (p.customFieldUpdates?.length ?? 0),
          0,
        ) +
        contactUpdateProposals.reduce(
          (n, p) => n + p.changes.length + (p.customFieldUpdates?.length ?? 0),
          0,
        )

      if (
        totalFieldCount > 0 &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          const notif = new Notification('Meeting summarized', {
            body: `${totalFieldCount} field${totalFieldCount !== 1 ? 's' : ''} ready to review`,
          })
          notif.onclick = () => {
            window.focus()
            window.location.hash = `#/meeting/${meetingId}`
            notif.close()
          }
        } catch {
          /* ignore — notification permission may have been revoked mid-run */
        }
      }

      setState(meetingId, {
        inProgress: false,
        phase: '',
        streamedSummary: '',
        pendingResult: result,
      })
    },
    [setState],
  )

  const stopEnhancement = useCallback(() => {
    void api.invoke(IPC_CHANNELS.SUMMARY_ABORT)
  }, [])

  const consumePendingResult = useCallback(
    (meetingId: string): SummaryGenerateResult | null => {
      const prev = states.current.get(meetingId)
      if (!prev || !prev.pendingResult) return null
      const taken = prev.pendingResult
      states.current.set(meetingId, { ...prev, pendingResult: null })
      // No notify: consumers re-render via their own state once they
      // act on the consumed result.
      return taken
    },
    [],
  )

  const value: EnhancementContextValue = {
    startEnhancement,
    stopEnhancement,
    consumePendingResult,
    getState,
    subscribe,
  }

  return (
    <EnhancementContext.Provider value={value}>
      {children}
    </EnhancementContext.Provider>
  )
}

export interface UseEnhancementReturn {
  state: PerMeetingState
  startEnhancement: (templateId: string) => Promise<void>
  stopEnhancement: () => void
  consumePendingResult: () => SummaryGenerateResult | null
}

/**
 * Subscribe a component to enhancement state for a specific meeting.
 * Pass `undefined` if the meetingId isn't ready yet — the hook returns
 * the empty state and no-op actions.
 */
export function useEnhancement(meetingId: string | undefined): UseEnhancementReturn {
  const ctx = useContext(EnhancementContext)
  if (!ctx) throw new Error('useEnhancement must be used within EnhancementProvider')

  const [, force] = useState(0)

  useEffect(() => {
    if (!meetingId) return
    return ctx.subscribe(meetingId, () => force((n) => n + 1))
  }, [ctx, meetingId])

  const state = meetingId ? ctx.getState(meetingId) : EMPTY

  const startEnhancement = useCallback(
    (templateId: string) =>
      meetingId ? ctx.startEnhancement(meetingId, templateId) : Promise.resolve(),
    [ctx, meetingId],
  )

  const consumePendingResult = useCallback(
    () => (meetingId ? ctx.consumePendingResult(meetingId) : null),
    [ctx, meetingId],
  )

  return {
    state,
    startEnhancement,
    stopEnhancement: ctx.stopEnhancement,
    consumePendingResult,
  }
}
