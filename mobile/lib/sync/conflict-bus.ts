// =============================================================================
// conflict-bus.ts — pub/sub for sync 409 conflicts.
//
// The sync agent runs as a module singleton and has no concept of which
// screen is mounted. When a PATCH returns 409, the agent calls
// publishConflict(); the meeting-detail screen subscribes on mount and
// shows the NotesConflictModal when a conflict for the currently-viewed
// meeting arrives.
//
// Zustand isn't pulled in here because the surface is tiny — a single
// listener set + dispatch fn. Tests stub the publish path via the
// exported `__subscribersForTest()`.
// =============================================================================

export interface ConflictEvent {
  meetingId: string
  /** What the user typed (the loser of the LWW race). */
  yours: string | null
  /** What the server has now. */
  theirs: string | null
  /** Server lamport at the time of the 409 — for replay attempts. */
  serverLamport: string
}

type Listener = (event: ConflictEvent) => void

const listeners = new Set<Listener>()

export function subscribeToConflicts(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishConflict(event: ConflictEvent): void {
  for (const l of [...listeners]) {
    try {
      l(event)
    } catch {
      // A misbehaving listener shouldn't break others.
    }
  }
}

/** Test-only — observe the current listener count. */
export function __subscribersForTest(): number {
  return listeners.size
}
