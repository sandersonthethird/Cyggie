import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { readLocalFile } from '../storage/file-manager'
import {
  isFlaggedAnywhere,
  isFlaggedForCompany,
  toggleFileFlag,
} from '@cyggie/db/sqlite/repositories/company-file-flags.repo'

// file.ipc.ts — capability-scoped file reads.
//
// PR1 left FILE_READ_CONTENT(arbitrary-path) as a known capability hole: the
// renderer could ask main to read any file under the user's permissions.
// PR2 replaces it with FILE_READ_BY_FLAGGED_ID, which only reads files that
// have a row in `company_flagged_files`.
//
//   Renderer ─► FILE_READ_BY_FLAGGED_ID({id, companyId?, fileName?, mimeType?})
//             │
//             ▼
//          ┌──────────────────────────────────────────────┐
//          │ Already flagged?                             │
//          │   yes (anywhere) ──► resolve → ext → read    │
//          │   no  ──► companyId provided?                │
//          │           yes ──► insert row (auto-flag)     │
//          │                   then resolve → ext → read  │
//          │           no  ──► reject                     │
//          └──────────────────────────────────────────────┘
//
// Auto-flag-on-drag is a deliberate UX preservation (decision 6C in the
// security plan review). The original FILE_READ_CONTENT flow allowed the
// renderer to read any path in the company-files listing — flagged or not.
// With strict-only lookup, dragging an unflagged file would 404. Auto-flag
// preserves the UX and as a side effect marks the file in the flagged-files
// UI for future discoverability.

const SUPPORTED_EXTS = ['.pdf', '.txt', '.md', '.csv']

interface ReadByIdArgs {
  /** Drive file ID or local FS path — same shape as `company_flagged_files.file_id`. */
  id: string
  /** When provided AND the id isn't already flagged for this company, auto-flag. */
  companyId?: string
  /** Display name stored on the auto-flag row. Ignored if already flagged. */
  fileName?: string
  /** Mime type stored on the auto-flag row. Ignored if already flagged. */
  mimeType?: string | null
}

interface ReadByIdResult {
  content: string | null
  error: string | null
}

export function registerFileHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
    async (_event, args: ReadByIdArgs): Promise<ReadByIdResult> => {
      if (!args || typeof args !== 'object' || typeof args.id !== 'string' || !args.id.trim()) {
        return { content: null, error: 'No file id provided' }
      }
      const { id, companyId, fileName, mimeType } = args

      // Capability check: the file must be flagged for SOME company, OR the
      // caller must provide a companyId so we can auto-flag it on the spot.
      if (companyId) {
        if (!isFlaggedForCompany(companyId, id)) {
          toggleFileFlag(companyId, id, fileName ?? id, mimeType ?? null)
        }
      } else if (!isFlaggedAnywhere(id)) {
        return { content: null, error: 'File is not flagged and no companyId provided to auto-flag' }
      }

      // Extension check guards against text-extraction on non-text formats
      // (binary blobs, .key files, etc.) even if they somehow ended up flagged.
      const ext = id.includes('.') ? '.' + id.split('.').pop()!.toLowerCase() : ''
      if (!SUPPORTED_EXTS.includes(ext)) {
        return { content: null, error: `Unsupported format. Supported: ${SUPPORTED_EXTS.join(', ')}` }
      }

      try {
        const content = await readLocalFile(id)
        if (!content) return { content: null, error: 'File could not be read (empty or unreadable)' }
        return { content, error: null }
      } catch (err) {
        return { content: null, error: String(err) }
      }
    },
  )
}
