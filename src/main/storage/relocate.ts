import { copyFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { getTranscriptsDir, getSummariesDir, getRecordingsDir, getMemosDir } from './paths'
import {
  isTwoTierStorageEnabled,
  rootForMeeting,
  resolveExistingFile,
  invalidateResolveCache,
  type StorageKind,
} from './routing'

// ─────────────────────────────────────────────────────────────────────────────
// Relocation on is_private toggle (Slice 3f).
//
// When a meeting's privacy flips, its on-disk files must move between the
// per-user PRIVATE (local) root and the firm SHARED (Drive) root. Each file is
// moved copy → verify → delete-source → invalidate-cache, so a reader is never
// left with zero copies if the process dies mid-move. Idempotent: a file already
// in the destination root is skipped.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeetingFiles {
  transcript?: string | null
  summary?: string | null
  recording?: string | null
}

export interface RelocationResult {
  moved: Array<{ kind: StorageKind; filename: string; bytes: number }>
  skipped: number
  /** True when the destination would HOLD (public + shared root unresolved):
   *  files are left in place rather than mis-filed. */
  held: boolean
}

function dirForKind(kind: StorageKind, root: string): string {
  switch (kind) {
    case 'transcript':
      return getTranscriptsDir(root)
    case 'summary':
      return getSummariesDir(root)
    case 'recording':
      return getRecordingsDir(root)
    case 'memo':
      return getMemosDir(root)
  }
}

/** A .webm recording has a derived `.play.mp4` sibling worth relocating too. */
function playVariant(filename: string): string | null {
  if (!filename.toLowerCase().endsWith('.webm')) return null
  const ext = extname(filename)
  return `${basename(filename, ext)}.play.mp4`
}

/**
 * Relocate a meeting's files between roots after its is_private flips. Returns
 * what moved (for logging/metrics). No-op when the flag is off. When the
 * destination would HOLD (toggling public while the shared root is unresolved),
 * the files stay in place (held=true) and remain readable via resolveExistingFile;
 * a later refresh / re-toggle moves them.
 *
 * Synchronous (better-sqlite3-style); callers run it off the IPC reply.
 */
export function relocateMeetingFiles(
  meetingId: string,
  isPrivate: boolean,
  files: MeetingFiles,
): RelocationResult {
  const result: RelocationResult = { moved: [], skipped: 0, held: false }
  if (!isTwoTierStorageEnabled()) return result

  const route = rootForMeeting({ isPrivate })
  if (route.kind === 'hold') {
    console.warn(
      `[TwoTier] relocate HELD meeting=${meetingId} — shared root unresolved, leaving files in place`,
    )
    result.held = true
    return result
  }
  const destRoot = route.root

  const candidates: Array<{ kind: StorageKind; filename: string }> = []
  if (files.transcript) candidates.push({ kind: 'transcript', filename: files.transcript })
  if (files.summary) candidates.push({ kind: 'summary', filename: files.summary })
  if (files.recording) {
    candidates.push({ kind: 'recording', filename: files.recording })
    const play = playVariant(files.recording)
    if (play) candidates.push({ kind: 'recording', filename: play })
  }

  for (const { kind, filename } of candidates) {
    const dest = join(dirForKind(kind, destRoot), filename)
    // Find the file wherever it currently lives (probes both roots + staging).
    const current = resolveExistingFile({ id: meetingId, isPrivate }, kind, filename)
    if (!current) continue // nothing to move (e.g. an absent .play.mp4 variant)
    if (current === dest) {
      result.skipped++ // already in the destination root
      continue
    }

    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(current, dest)
      // Verify the copy before deleting the source — never leave zero copies.
      if (!existsSync(dest) || statSync(dest).size !== statSync(current).size) {
        if (existsSync(dest)) unlinkSync(dest)
        console.warn(
          `[TwoTier] relocate verify FAILED meeting=${meetingId} kind=${kind} file=${filename}`,
        )
        result.skipped++
        continue
      }
      const bytes = statSync(dest).size
      unlinkSync(current)
      invalidateResolveCache(meetingId)
      result.moved.push({ kind, filename, bytes })
    } catch (err) {
      console.warn(
        `[TwoTier] relocate error meeting=${meetingId} kind=${kind} file=${filename}:`,
        err,
      )
      result.skipped++
    }
  }

  const totalBytes = result.moved.reduce((n, m) => n + m.bytes, 0)
  console.log(
    `[TwoTier] relocate done meeting=${meetingId} private=${isPrivate} moved=${result.moved.length} bytes=${totalBytes} skipped=${result.skipped}`,
  )
  return result
}
