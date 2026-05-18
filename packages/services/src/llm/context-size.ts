import type { ContextSizeEstimate } from '@shared/types/company'

/**
 * Pure helpers that estimate prompt char-size from already-known counts and
 * file metadata, WITHOUT reading any file content. Used by both the memo-gen
 * preflight IPC and the chat-context-size preflight IPC.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Why estimate (instead of measure)?                             │
 *   │                                                                  │
 *   │  Reading 6 large PDFs to compute their actual extracted size    │
 *   │  takes ~8-12s. Preflight needs to be cheap (<50ms) so the       │
 *   │  renderer can show a warning modal BEFORE generation starts.    │
 *   │  We bound by mime-type heuristics: PDF compresses ~20:1 to       │
 *   │  text, DOCX ~2.5:1, plain text 1:1, etc. Per-file estimate is    │
 *   │  then capped at perFileCap and total at totalCap (matching the   │
 *   │  caps the actual generate path enforces).                        │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The estimate is intentionally an UPPER BOUND. If we underestimate, the
 * user sees a memo larger than warned — bad. If we overestimate, the user
 * gets a warning they didn't strictly need — fine. Bias toward warnings.
 *
 * NOTE: file size in bytes is currently NOT in the company_flagged_files
 * table (Phase-2 follow-up adds size_bytes column). When sizeBytes is 0,
 * we fall back to a per-mime default size constant.
 */

/** Trigger the warning modal when total estimated prompt > this many chars. */
export const LARGE_CONTEXT_WARNING_CHARS = 150_000

const SONNET_INPUT_RATE_USD_PER_M = 3
const CHARS_PER_TOKEN = 4

interface FileInput {
  fileName: string
  sizeBytes: number       // 0 means unknown (use mime fallback)
  mimeType: string | null
}

interface MimeProfile {
  /** Multiplier from on-disk bytes to extracted text chars. */
  bytesToChars: number
  /** Default extracted-text chars when sizeBytes is unknown (0). */
  defaultChars: number
}

/**
 * Per-mime extraction-size heuristics. Conservative defaults — overestimate
 * is OK; underestimate causes silent over-budget runs.
 */
function profileForMime(mime: string | null): MimeProfile {
  if (!mime) return { bytesToChars: 0.5, defaultChars: 30_000 }
  if (mime === 'application/pdf') return { bytesToChars: 0.05, defaultChars: 30_000 }
  if (mime.includes('officedocument.wordprocessingml')) return { bytesToChars: 0.4, defaultChars: 20_000 }
  if (mime.includes('officedocument.spreadsheetml')) return { bytesToChars: 0.3, defaultChars: 15_000 }
  if (mime.includes('officedocument.presentationml')) return { bytesToChars: 0.1, defaultChars: 25_000 }
  if (mime.startsWith('text/')) return { bytesToChars: 1.0, defaultChars: 8_000 }
  // Google Docs / Sheets / Slides — files referenced by Drive id; no on-disk size.
  if (mime.startsWith('application/vnd.google-apps.')) return { bytesToChars: 0, defaultChars: 30_000 }
  return { bytesToChars: 0.5, defaultChars: 20_000 }
}

function estimateFileChars(file: FileInput, perFileCap: number): number {
  const profile = profileForMime(file.mimeType)
  const fromBytes = file.sizeBytes > 0 ? file.sizeBytes * profile.bytesToChars : 0
  const raw = fromBytes > 0 ? fromBytes : profile.defaultChars
  return Math.min(perFileCap, Math.round(raw))
}

export interface MemoGenContextEstimateInput {
  flaggedFiles: FileInput[]
  meetingCount: number
  summaryCount: number
  transcriptCount: number
  companyNoteCount: number
  contactNoteCount: number
  contactKeyTakeawayCount: number
  emailCount: number
  /** Adds the niche query's expected result chars (~4500). */
  hasNicheSignal: boolean
  /** Number of founder LinkedIn queries (each adds ~4500 chars of results). */
  founderCount: number
  /** Pre-research has an industry market-size query when industry is set. */
  hasIndustryQuery: boolean
  caps: { perItemCap: number; totalCap: number }
}

const PER_SUMMARY_CAP = 8_000
const PER_TRANSCRIPT_CAP = 10_000
const TRANSCRIPTS_TOTAL_CAP = 30_000
const PER_NOTE_CAP = 3_000
const CONTACT_NOTES_TOTAL_CAP = 20_000
const PER_EMAIL_CAP = 3_000
const EMAILS_TOTAL_CAP = 20_000
const PER_TAKEAWAY_CAP = 800
const KEYTAKEAWAYS_MAX_CONTACTS = 8
const PER_EXA_RESULT_CAP = 1_500
const EXA_RESULTS_PER_QUERY = 3
const OTHER_BASELINE_CHARS = 2_000   // system prompt + company description + themes + headers

/**
 * Estimate total prompt char-size for a memo-generation run. Bias upward —
 * see the file header.
 */
export function estimateMemoGenContext(
  input: MemoGenContextEstimateInput,
): ContextSizeEstimate {
  // Files: per-file capped, total capped.
  let filesChars = 0
  const fileBreakdown: ContextSizeEstimate['fileBreakdown'] = []
  for (const file of input.flaggedFiles) {
    if (filesChars >= input.caps.totalCap) break
    const est = estimateFileChars(file, input.caps.perItemCap)
    const fitted = Math.min(est, input.caps.totalCap - filesChars)
    fileBreakdown.push({ name: file.fileName, sizeBytes: file.sizeBytes, estChars: fitted })
    filesChars += fitted
  }

  // Meetings: summaries + transcripts (transcripts have a separate total cap).
  const summariesChars = input.summaryCount * PER_SUMMARY_CAP
  const transcriptsChars = Math.min(input.transcriptCount * PER_TRANSCRIPT_CAP, TRANSCRIPTS_TOTAL_CAP)
  const meetingsChars = summariesChars + transcriptsChars

  // Notes: company has no collective cap; contact has 20k.
  const companyNotesChars = input.companyNoteCount * PER_NOTE_CAP
  const contactNotesChars = Math.min(input.contactNoteCount * PER_NOTE_CAP, CONTACT_NOTES_TOTAL_CAP)
  const notesChars = companyNotesChars + contactNotesChars

  // Emails: per-email body capped at 3k, total 20k.
  const emailsChars = Math.min(input.emailCount * PER_EMAIL_CAP, EMAILS_TOTAL_CAP)

  // Contact key takeaways: up to 8 contacts × 800 chars.
  const contactProfilesChars =
    Math.min(input.contactKeyTakeawayCount, KEYTAKEAWAYS_MAX_CONTACTS) * PER_TAKEAWAY_CAP

  // External research: 3 results × 1.5k per query; query count = niche + industry + founders.
  let externalQueryCount = 0
  if (input.hasNicheSignal) externalQueryCount += 1
  if (input.hasIndustryQuery) externalQueryCount += 1
  externalQueryCount += Math.min(input.founderCount, 2)
  const externalResearchChars = externalQueryCount * EXA_RESULTS_PER_QUERY * PER_EXA_RESULT_CAP

  const otherChars = OTHER_BASELINE_CHARS

  const totalChars =
    filesChars + meetingsChars + notesChars + emailsChars + contactProfilesChars + externalResearchChars + otherChars

  const estTokens = Math.round(totalChars / CHARS_PER_TOKEN)
  const estCostUsd = (estTokens * SONNET_INPUT_RATE_USD_PER_M) / 1_000_000

  return {
    totalChars,
    estTokens,
    estCostUsd,
    willTriggerWarning: totalChars > LARGE_CONTEXT_WARNING_CHARS,
    breakdown: {
      meetings: meetingsChars,
      notes: notesChars,
      emails: emailsChars,
      files: filesChars,
      externalResearch: externalResearchChars,
      contactProfiles: contactProfilesChars,
      other: otherChars,
    },
    fileBreakdown,
  }
}

/**
 * Smaller estimate for chat per-turn context. Same machinery as memo gen but
 * with the smaller chat caps and without the memo-only sources (emails,
 * contact notes, external research).
 *
 * Maps to context-builders.ts:
 *   COMPANY_SUMMARY_CAPS  perItem 8k, total 30k
 *   COMPANY_NOTE_CAPS     perItem 2k, total 8k
 *   COMPANY_FILE_CAPS     perItem 48k, total 300k (after this PR)
 */
export interface ChatContextEstimateInput {
  flaggedFiles: FileInput[]
  summaryCount: number
  companyNoteCount: number
  caps: { perItemCap: number; totalCap: number }
}

export function estimateChatContext(input: ChatContextEstimateInput): ContextSizeEstimate {
  let filesChars = 0
  const fileBreakdown: ContextSizeEstimate['fileBreakdown'] = []
  for (const file of input.flaggedFiles) {
    if (filesChars >= input.caps.totalCap) break
    const est = estimateFileChars(file, input.caps.perItemCap)
    const fitted = Math.min(est, input.caps.totalCap - filesChars)
    fileBreakdown.push({ name: file.fileName, sizeBytes: file.sizeBytes, estChars: fitted })
    filesChars += fitted
  }

  const summariesChars = Math.min(input.summaryCount * PER_SUMMARY_CAP, 30_000)
  const notesChars = Math.min(input.companyNoteCount * 2_000, 8_000)
  const otherChars = OTHER_BASELINE_CHARS

  const totalChars = filesChars + summariesChars + notesChars + otherChars
  const estTokens = Math.round(totalChars / CHARS_PER_TOKEN)
  const estCostUsd = (estTokens * SONNET_INPUT_RATE_USD_PER_M) / 1_000_000

  return {
    totalChars,
    estTokens,
    estCostUsd,
    willTriggerWarning: totalChars > LARGE_CONTEXT_WARNING_CHARS,
    breakdown: {
      meetings: summariesChars,
      notes: notesChars,
      emails: 0,
      files: filesChars,
      externalResearch: 0,
      contactProfiles: 0,
      other: otherChars,
    },
    fileBreakdown,
  }
}
