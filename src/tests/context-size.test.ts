import { describe, it, expect } from 'vitest'
import {
  estimateMemoGenContext,
  estimateChatContext,
  LARGE_CONTEXT_WARNING_CHARS,
} from '@cyggie/services/llm/context-size'

const MEMO_CAPS = { perItemCap: 64_000, totalCap: 400_000 }
const CHAT_CAPS = { perItemCap: 48_000, totalCap: 300_000 }

const EMPTY_MEMO_INPUT = {
  flaggedFiles: [],
  meetingCount: 0,
  summaryCount: 0,
  transcriptCount: 0,
  companyNoteCount: 0,
  contactNoteCount: 0,
  contactKeyTakeawayCount: 0,
  emailCount: 0,
  hasNicheSignal: false,
  founderCount: 0,
  hasIndustryQuery: false,
  caps: MEMO_CAPS,
}

describe('estimateMemoGenContext — baseline', () => {
  it('returns only the "other" baseline for an empty company', () => {
    const r = estimateMemoGenContext(EMPTY_MEMO_INPUT)
    expect(r.totalChars).toBe(2_000)
    expect(r.breakdown.other).toBe(2_000)
    expect(r.breakdown.meetings).toBe(0)
    expect(r.breakdown.files).toBe(0)
    expect(r.breakdown.externalResearch).toBe(0)
    expect(r.willTriggerWarning).toBe(false)
  })

  it('computes estTokens and estCostUsd from totalChars', () => {
    const r = estimateMemoGenContext({ ...EMPTY_MEMO_INPUT, summaryCount: 5 })
    // 5 * 8000 + 2000 = 42000 chars / 4 = 10500 tokens
    expect(r.estTokens).toBe(10_500)
    // 10500 * 3 / 1M = 0.0315
    expect(r.estCostUsd).toBeCloseTo(0.0315, 4)
  })
})

describe('estimateMemoGenContext — per-mime file size estimation', () => {
  it('PDFs: bytes × 0.05 (heavy compression)', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [{ fileName: 'deck.pdf', sizeBytes: 1_000_000, mimeType: 'application/pdf' }],
    })
    // 1MB * 0.05 = 50000 chars; under perFileCap of 64000
    expect(r.fileBreakdown[0]!.estChars).toBe(50_000)
  })

  it('DOCX: bytes × 0.4 (moderate compression)', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [{
        fileName: 'memo.docx',
        sizeBytes: 50_000,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(20_000)
  })

  it('plain text: bytes × 1.0 (no compression)', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [{ fileName: 'notes.txt', sizeBytes: 5_000, mimeType: 'text/plain' }],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(5_000)
  })

  it('Google Docs (no on-disk size): falls back to 30k default', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [{
        fileName: 'doc',
        sizeBytes: 0,
        mimeType: 'application/vnd.google-apps.document',
      }],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(30_000)
  })

  it('unknown mime: falls back to bytes × 0.5 (conservative)', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [{ fileName: 'mystery.bin', sizeBytes: 100_000, mimeType: 'application/octet-stream' }],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(50_000)
  })

  it('null mime: falls back to bytes × 0.5 with 30k default', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [
        { fileName: 'a', sizeBytes: 100_000, mimeType: null }, // bytes route
        { fileName: 'b', sizeBytes: 0, mimeType: null },        // default route
      ],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(50_000)
    expect(r.fileBreakdown[1]!.estChars).toBe(30_000)
  })
})

describe('estimateMemoGenContext — cap enforcement', () => {
  it('per-file estimate is capped at perFileCap', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: [
        // 5MB PDF would extract to 250000 chars; capped at 64000
        { fileName: 'huge.pdf', sizeBytes: 5_000_000, mimeType: 'application/pdf' },
      ],
    })
    expect(r.fileBreakdown[0]!.estChars).toBe(64_000)
  })

  it('total file content is capped at totalCap', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: Array.from({ length: 10 }, (_, i) => ({
        fileName: `file-${i}.pdf`,
        sizeBytes: 2_000_000,    // 100k chars after extraction; capped at 64k per file
        mimeType: 'application/pdf',
      })),
    })
    // 10 files × 64k = 640k, but totalCap is 400k → some files truncated/dropped
    expect(r.breakdown.files).toBeLessThanOrEqual(400_000)
    expect(r.breakdown.files).toBe(400_000)
  })

  it('stops adding files once totalCap is reached', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      flaggedFiles: Array.from({ length: 8 }, (_, i) => ({
        fileName: `file-${i}.pdf`,
        sizeBytes: 2_000_000,
        mimeType: 'application/pdf',
      })),
    })
    // 6 files at 64k = 384k. 7th adds 16k to hit 400k. 8th: 0 chars (cap hit).
    const includedFiles = r.fileBreakdown.filter(f => f.estChars > 0).length
    expect(includedFiles).toBeLessThanOrEqual(7)
  })
})

describe('estimateMemoGenContext — willTriggerWarning boundary', () => {
  it('149k → false', () => {
    // Construct an input that totals just below the 150k threshold
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      summaryCount: 18, // 18 * 8000 = 144000
      // + 2000 baseline = 146000
    })
    expect(r.totalChars).toBe(146_000)
    expect(r.willTriggerWarning).toBe(false)
  })

  it('151k → true', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      summaryCount: 19, // 19 * 8000 = 152000 + 2000 = 154000
    })
    expect(r.totalChars).toBeGreaterThan(LARGE_CONTEXT_WARNING_CHARS)
    expect(r.willTriggerWarning).toBe(true)
  })
})

describe('estimateMemoGenContext — external research query count', () => {
  it('counts niche + industry + 2 founders = 4 queries', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      hasNicheSignal: true,
      hasIndustryQuery: true,
      founderCount: 5,    // capped at 2 by buildPreResearchQueries
    })
    // 4 queries × 3 results × 1500 chars = 18000
    expect(r.breakdown.externalResearch).toBe(18_000)
  })

  it('zero queries when nothing seeds external research', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      hasNicheSignal: false,
      hasIndustryQuery: false,
      founderCount: 0,
    })
    expect(r.breakdown.externalResearch).toBe(0)
  })
})

describe('estimateMemoGenContext — typical realistic input', () => {
  it('matches expected totals for a "medium" company (5 meetings, 10 notes, 30 emails, 3 small files)', () => {
    const r = estimateMemoGenContext({
      ...EMPTY_MEMO_INPUT,
      meetingCount: 5,
      summaryCount: 5,
      transcriptCount: 0,
      companyNoteCount: 10,
      contactNoteCount: 4,
      contactKeyTakeawayCount: 2,
      emailCount: 30,
      hasNicheSignal: true,
      hasIndustryQuery: true,
      founderCount: 2,
      flaggedFiles: [
        { fileName: 'pitch.pdf', sizeBytes: 800_000, mimeType: 'application/pdf' },     // 40k
        { fileName: 'model.xlsx', sizeBytes: 100_000, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, // 30k
        { fileName: 'memo.docx', sizeBytes: 30_000, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, // 12k
      ],
    })
    // Files: 40000 + 30000 + 12000 = 82000
    // Meetings: 5 * 8000 = 40000
    // Notes: 10 * 3000 + min(4*3000, 20000) = 30000 + 12000 = 42000
    // Emails: min(30 * 3000, 20000) = 20000
    // Contact profiles: 2 * 800 = 1600
    // External: (1 + 1 + 2) * 3 * 1500 = 18000
    // Other: 2000
    // Total: 82000 + 40000 + 42000 + 20000 + 1600 + 18000 + 2000 = 205600
    expect(r.totalChars).toBe(205_600)
    expect(r.willTriggerWarning).toBe(true)
  })
})

describe('estimateChatContext', () => {
  it('uses smaller chat caps and excludes memo-only sources', () => {
    const r = estimateChatContext({
      flaggedFiles: [
        { fileName: 'deck.pdf', sizeBytes: 1_000_000, mimeType: 'application/pdf' },
      ],
      summaryCount: 3,
      companyNoteCount: 5,
      caps: CHAT_CAPS,
    })
    // Files: 50k (capped at perItem 48k)
    // Summaries: 3 * 8000 = 24000
    // Notes: min(5 * 2000, 8000) = 8000
    // Other: 2000
    // Total: 48000 + 24000 + 8000 + 2000 = 82000
    expect(r.totalChars).toBe(82_000)
    expect(r.breakdown.emails).toBe(0)         // chat doesn't include emails
    expect(r.breakdown.externalResearch).toBe(0)
    expect(r.breakdown.contactProfiles).toBe(0)
  })
})
