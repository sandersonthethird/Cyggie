import { Alert } from 'react-native'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { type ChatContextKind, updateChatSession } from '../lib/api/chat'

// =============================================================================
// useStartNewChat — shared mutation hook backing the "New Chat" affordance
// in both the global Ask Cyggie tab and per-entity chat screens.
//
// Flow:
//   tap → abortInflight?.() ──┐
//                             ├─→ early return if no session / empty session
//                             ↓
//                  updateChatSession(isArchived: true)
//                             ↓
//   ┌───────────────┬─────────┴────────┬───────────────┐
//   200 OK         409 conflict       network throw
//   ↓              ↓                   ↓
//   invalidate     surfaceFailure      surfaceFailure
//   queries        ('conflict')        ('network')
//   ↓              (Alert.alert)       (Alert.alert)
//   onStarted?()
//
// Outcomes are returned via a discriminated union (mirrors the contract
// of updateChatSession + sendSessionMessage) so callers can act on
// success/failure without depending on thrown Error.message strings —
// UI copy lives only inside surfaceFailure(), not the data layer.
// =============================================================================

export type StartNewChatOutcome =
  | { ok: true }
  | {
      ok: false
      reason: 'no-session' | 'empty' | 'conflict' | 'network'
      message?: string
    }

export interface UseStartNewChatArgs {
  sessionId: string | undefined
  contextKind: ChatContextKind
  contextId: string
  messageCount: number
  /**
   * Optional abort hook. Called BEFORE the archive PATCH fires so any
   * in-flight LLM send terminates cleanly (no token spend, no silent
   * "answer landed in the archived session" trap). Wired by both wrapper
   * screens via ChatComposer's imperative ref.
   */
  abortInflight?: () => void
  /** Fires once on `{ok: true}` so per-entity callers can close the
   *  actions sheet. */
  onStarted?: () => void
}

export function useStartNewChat(args: UseStartNewChatArgs) {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<StartNewChatOutcome> => {
      if (!args.sessionId) return { ok: false, reason: 'no-session' }
      if (args.messageCount === 0) return { ok: false, reason: 'empty' }

      // Abort any in-flight send synchronously so it never lands on the
      // session we're about to archive. The aborted send's existing
      // onError({code:'network'}) path renders the standard "connection
      // dropped" bubble, which the clear-on-session-swap useEffect drops
      // as soon as the new sessionId arrives.
      args.abortInflight?.()

      let result: Awaited<ReturnType<typeof updateChatSession>>
      try {
        result = await updateChatSession(args.sessionId, { isArchived: true })
      } catch (err) {
        return {
          ok: false,
          reason: 'network',
          message: err instanceof Error ? err.message : String(err),
        }
      }

      if (!result.ok) return { ok: false, reason: 'conflict' }

      // session-by-context drives ChatComposer's sessionQuery — invalidating
      // it triggers a refetch which calls createOrGetChatSession, which
      // returns a fresh active session now that the old one is isActive=0.
      // sessions-list drives the past-chats sheet so the just-archived row
      // becomes visible there.
      qc.invalidateQueries({
        queryKey: ['chat', 'session-by-context', args.contextKind, args.contextId],
      })
      qc.invalidateQueries({ queryKey: ['chat', 'sessions-list'] })

      args.onStarted?.()
      return { ok: true }
    },
    onSuccess: (outcome) => {
      if (!outcome.ok) surfaceFailure(outcome)
    },
  })
}

// User-facing copy lives ONLY here — callers don't construct error
// strings. Matches the existing pin/archive Alert.alert pattern in
// SessionActionsSheet so both surfaces feel consistent.
function surfaceFailure(
  outcome: Extract<StartNewChatOutcome, { ok: false }>,
): void {
  switch (outcome.reason) {
    case 'no-session':
    case 'empty':
      // No-op surfaces — these are legitimate early returns (button was
      // disabled by the caller, so this is defensive).
      return
    case 'conflict':
      Alert.alert(
        'Could not start a new chat',
        'Someone else just changed this chat. Refresh and try again.',
      )
      return
    case 'network':
      Alert.alert(
        'Could not start a new chat',
        "Couldn't reach the server. Check your connection and try again.",
      )
      return
  }
}
