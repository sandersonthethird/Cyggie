// =============================================================================
// mount-action.ts — pure decision function for record.tsx cold-start.
//
// The /record screen's useEffect has to choose one of five paths based on
// (a) the current Zustand store status, (b) the most-recent MMKV
// pendingUpload (if any), and (c) for the awaiting_transcription case,
// the live status of the meeting on the gateway. Encoding that 5-branch
// state machine as a pure function lets us unit-test it without standing
// up a React renderer — the hook itself becomes a thin dispatcher.
//
// Mirrors the poll-action.ts pattern: zero React Native imports,
// duck-typed where possible so the dependency graph stays tiny.
//
// State table (matches the test matrix in __tests__/mount-action.test.ts):
//
//   storeStatus   | pending entry        | gateway probe        | result
//   --------------|----------------------|----------------------|------------------------
//   recording     | *                    | (skipped)            | preserve (noop)
//   uploading     | *                    | (skipped)            | preserve (noop)
//   transcribing  | * (file safety net)  | (skipped)            | reset+startFresh
//   done          | *                    | (skipped)            | reset+startFresh
//   error         | *                    | (skipped)            | reset+startFresh
//   idle          | none                 | (skipped)            | startFresh
//   idle          | has meetingId        | 'transcribing'/      | reAttachPoll(meetingId)
//                 |                      |  'recording'         |
//   idle          | has meetingId        | terminal             | discardAndStartFresh
//   idle          | has meetingId        | 404                  | discardAndStartFresh
//   idle          | has meetingId        | other fetch error    | reAttachPoll(meetingId)
//                 |                      |                      |    (conservative)
//   idle          | no meetingId         | (no probe needed)    | showRetryUI(loaded)
//
// "Reset" means the store goes to 'idle'; the leftover MMKV entry is
// left INTACT so the older recording's audio file remains available for
// retry-upload from the meeting detail screen. This is the audio
// safety-net invariant — files are deleted only when their transcription
// reaches a terminal status.
// =============================================================================

import type { PendingUpload } from './pending-upload'

export type StoreStatus =
  | 'idle'
  | 'recording'
  | 'uploading'
  | 'transcribing'
  | 'done'
  | 'error'

export type MountAction =
  /** Active local work in progress — don't touch anything. */
  | { kind: 'preserve' }
  /** Cold-start with no pending state — just startRecording. */
  | { kind: 'start-fresh' }
  /**
   * Leftover non-idle store state (transcribing/done/error). Reset the
   * store and start a new recording. The MMKV pendingUpload (if any) is
   * preserved — its safety net survives this transition.
   */
  | { kind: 'reset-and-start-fresh' }
  /**
   * Stale meetingId in MMKV but the gateway says the meeting has reached
   * a terminal status. Discard that specific pendingUpload (file + slot)
   * and start a fresh recording.
   */
  | { kind: 'discard-and-start-fresh'; clientRecordingId: string }
  /**
   * MMKV pendingUpload has a meetingId AND the gateway says it's still
   * in flight (or we couldn't reach the gateway to check). Re-attach the
   * poll so the user sees "Transcribing…" while it completes.
   */
  | { kind: 'reattach-poll'; meetingId: string }
  /**
   * MMKV pendingUpload exists but has no meetingId — the previous upload
   * failed. Show the retry-upload UI on /record.
   */
  | { kind: 'show-retry-ui'; pending: PendingUpload }

/**
 * Result of probing the gateway for an in-flight meeting. The caller
 * (record.tsx) feeds this into decideMountAction asynchronously after
 * a fetchMeeting call.
 *
 *   { kind: 'in-flight' }  → meeting is 'recording' or 'transcribing'
 *   { kind: 'terminal' }   → meeting is 'transcribed', 'empty', or 'error'
 *   { kind: 'gone' }       → fetch returned 404 (meeting deleted server-side)
 *   { kind: 'unknown' }    → fetch failed for some other reason (network)
 */
export type MeetingProbeResult =
  | { kind: 'in-flight' }
  | { kind: 'terminal' }
  | { kind: 'gone' }
  | { kind: 'unknown' }

export interface MountActionInput {
  storeStatus: StoreStatus
  pending: PendingUpload | null
  /**
   * Probe result for the pending entry's meetingId. Pass undefined if no
   * probe was performed (the function only consults this when the
   * decision branch actually needs it — i.e., idle + pending with
   * meetingId).
   */
  probe?: MeetingProbeResult
}

/**
 * Decide what /record should do on (re)mount.
 *
 * Inputs are deliberately minimal — passing the resolved probe rather
 * than a fetch function keeps the function synchronous + pure.
 */
export function decideMountAction(input: MountActionInput): MountAction {
  const { storeStatus, pending, probe } = input

  // Active local-side operation — leave the screen alone so we don't
  // interrupt a recording or upload in progress. Realistically only
  // reachable via deep link / programmatic navigation; from a normal FAB
  // tap the calendar UI is hidden behind /record so the user couldn't
  // have tapped it. Defensive early-return.
  if (storeStatus === 'recording' || storeStatus === 'uploading') {
    return { kind: 'preserve' }
  }

  // Leftover non-idle state (transcribing/done/error) from a previous
  // session the user backed out of. Honor the user's intent to record:
  // reset the store and start fresh. The MMKV pendingUpload (if any)
  // is preserved — that older recording's audio + safety net remain
  // intact in storage. Background server-side state is untouched too.
  if (storeStatus !== 'idle') {
    return { kind: 'reset-and-start-fresh' }
  }

  // Below here: store is 'idle' (cold launch or freshly reset).

  if (!pending) {
    return { kind: 'start-fresh' }
  }

  if (!pending.meetingId) {
    // Awaiting upload (previous upload failed). Show the retry UI so the
    // user can either re-upload from the local file or discard.
    return { kind: 'show-retry-ui', pending }
  }

  // Pending entry has a meetingId — it was successfully uploaded but the
  // poll wasn't running to see it through to terminal status. Need the
  // gateway probe result to know whether the meeting is still in-flight
  // or already done.
  if (!probe) {
    // No probe supplied — conservative default is to re-attach (assume
    // in-flight). Real callers should always supply a probe; this branch
    // exists for test-isolation simplicity.
    return { kind: 'reattach-poll', meetingId: pending.meetingId }
  }

  switch (probe.kind) {
    case 'in-flight':
      return { kind: 'reattach-poll', meetingId: pending.meetingId }
    case 'terminal':
    case 'gone':
      // Server-side already resolved (or the meeting was deleted). The
      // pendingUpload entry is stale — discard the file + slot. Start a
      // fresh recording.
      return { kind: 'discard-and-start-fresh', clientRecordingId: pending.clientRecordingId }
    case 'unknown':
      // Network blip — can't tell. Be conservative and re-attach the
      // poll. If the meeting really is terminal, the poll itself will
      // handle cleanup on its next successful tick.
      return { kind: 'reattach-poll', meetingId: pending.meetingId }
  }
}
