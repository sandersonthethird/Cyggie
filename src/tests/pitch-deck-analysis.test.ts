/**
 * Tests for runPitchDeckAnalysis covering the three failure branches added
 * with the vision-PDF re-read path:
 *
 *   ┌─ rawText present ────────────────────────────► LLM with text prompt
 *   │
 *   ├─ no rawText + sourceFilePath ──► readFileSync ─► LLM with PDF attachment
 *   │                                       │
 *   │                                       └── throws ─► return null (logged)
 *   │
 *   └─ no rawText + no sourceFilePath ───────────────► return null (logged)
 *
 *   LLM empty / short response ──────────────────────► return null (logged)
 *   LLM throws ──────────────────────────────────────► return null (logged)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateSummary = vi.fn()

vi.mock('@cyggie/services/llm/provider-factory', () => ({
  getProvider: () => ({
    name: 'mock',
    generateSummary,
    isAvailable: () => Promise.resolve(true),
    streamWithThinking: generateSummary,
  }),
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}))

const { runPitchDeckAnalysis } = await import('../main/services/pitch-deck-analysis.service')
const fs = (await import('fs')) as unknown as { readFileSync: ReturnType<typeof vi.fn> }

describe('runPitchDeckAnalysis', () => {
  beforeEach(() => {
    generateSummary.mockReset()
    fs.readFileSync.mockReset()
  })

  it('returns trimmed LLM response on the rawText happy path', async () => {
    generateSummary.mockResolvedValue('## Partner Sync Summary\nCompany: Acme\n\n## Full Analysis\nlong analysis here over 10 chars')
    const result = await runPitchDeckAnalysis({
      rawText: 'pitch deck text here',
      sourceFilePath: null,
      companyName: 'Acme',
      sourceLabel: null,
    })
    expect(result).toContain('## Partner Sync Summary')
    expect(generateSummary).toHaveBeenCalledTimes(1)
    // No attachments when rawText is present
    const callArgs = generateSummary.mock.calls[0]
    expect(callArgs[4]).toBeUndefined()
  })

  it('re-reads PDF from sourceFilePath when rawText is empty (vision path)', async () => {
    fs.readFileSync.mockReturnValue(Buffer.from('pdf-bytes'))
    generateSummary.mockResolvedValue('## Partner Sync Summary\nCompany: VisionCo\n\n## Full Analysis\nanalysis content')
    const result = await runPitchDeckAnalysis({
      rawText: '',
      sourceFilePath: '/tmp/deck.pdf',
      companyName: 'VisionCo',
      sourceLabel: null,
    })
    expect(result).not.toBeNull()
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/deck.pdf')
    // Attachment passed to LLM
    const attachments = generateSummary.mock.calls[0][4]
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      mimeType: 'application/pdf',
      type: 'pdf',
      name: 'deck.pdf',
    })
    expect(typeof attachments[0].data).toBe('string')
  })

  it('returns null when both rawText and sourceFilePath are absent', async () => {
    const result = await runPitchDeckAnalysis({
      rawText: '',
      sourceFilePath: null,
      companyName: null,
      sourceLabel: null,
    })
    expect(result).toBeNull()
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('returns null when readFileSync throws (PDF gone / inaccessible)', async () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await runPitchDeckAnalysis({
      rawText: '',
      sourceFilePath: '/tmp/missing.pdf',
      companyName: null,
      sourceLabel: null,
    })
    expect(result).toBeNull()
    expect(generateSummary).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns null when LLM returns an empty or short response', async () => {
    generateSummary.mockResolvedValue('   ')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await runPitchDeckAnalysis({
      rawText: 'some text',
      sourceFilePath: null,
      companyName: 'X',
      sourceLabel: null,
    })
    expect(result).toBeNull()
    warn.mockRestore()
  })

  it('returns null when LLM throws', async () => {
    generateSummary.mockRejectedValue(new Error('timeout'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await runPitchDeckAnalysis({
      rawText: 'some text',
      sourceFilePath: null,
      companyName: 'X',
      sourceLabel: null,
    })
    expect(result).toBeNull()
    errSpy.mockRestore()
  })
})
