// At app startup, flip any transcription_evaluations rows that have been
// stuck in 'pending' for longer than the threshold over to 'failed'.
//
// The typical cause is the user quitting the app while an alternate provider
// was mid-poll (AssemblyAI batch transcription takes 30-120s for a 1-hour
// meeting). Without this sweep, those rows accumulate as zombies and
// confuse the CLI's status filtering.

import { markStalePendingAsFailed } from '../repo/evaluations.repo'

const STALE_AFTER_MINUTES = 10

export function runEvalBootCleanup(): void {
  try {
    const changes = markStalePendingAsFailed(STALE_AFTER_MINUTES)
    if (changes > 0) {
      console.log(
        `[transcription-eval] Boot cleanup: marked ${changes} stale 'pending' row(s) as failed`,
      )
    }
  } catch (err) {
    console.warn('[transcription-eval] Boot cleanup failed (non-fatal):', err)
  }
}
