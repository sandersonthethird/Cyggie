import { useEffect, useRef } from 'react'

// =============================================================================
// useClearOnSessionSwap — fires `clear()` when sessionId transitions to a
// DIFFERENT non-null value. Skips the initial null→'abc' load so any
// state typed during the find-or-create round-trip survives the first
// session resolution.
//
// Used by ChatComposer to drop optimistic pending messages + typed input
// when the "New Chat" affordance archives + auto-creates a fresh session.
//
// Extracted to its own file so the swap semantics are testable without
// having to stand up an entire ChatComposer render (RN UI surface) — see
// mobile/components/__tests__/useClearOnSessionSwap.test.ts.
// =============================================================================

export function useClearOnSessionSwap(
  sessionId: string | undefined,
  clear: () => void,
): void {
  const prevRef = useRef<string | null>(null)
  useEffect(() => {
    // Both must be truthy + different. `prev && sessionId && ...` skips
    // the initial null→'abc' load AND defensively skips transitions to
    // `undefined` (e.g. transient cache eviction) — we only clear on a
    // real session swap.
    if (prevRef.current && sessionId && prevRef.current !== sessionId) {
      clear()
    }
    prevRef.current = sessionId ?? null
    // `clear` intentionally excluded from deps — we only want to react to
    // sessionId changes, not re-runs caused by an unstable clear callback.
    // Callers should pass a useCallback-stable clear if they care about
    // referential identity, but the effect's behavior is independent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
}
