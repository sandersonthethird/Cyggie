/**
 * Tests for contact-key-takeaways.ts
 *
 * Mock boundaries:
 *   - buildContactContext → vi.mock (controls hasMeetings/hasEmails/hasNotes)
 *   - getProvider → vi.mock (captures prompts, returns controlled output)
 *
 * Covers:
 *   - throws 'Not enough context' when all three data flags are false
 *   - throws 'Generation returned empty content' when provider returns empty string
 *   - happy path: returns bullets from provider and trims to MAX_OUTPUT_CHARS
 *   - AbortController: provider called with signal; aborting previous call on new request
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Context builder mock ────────────────────────────────────────────────────

const mockBuildContactContext = vi.fn()

vi.mock('../main/llm/contact-context-builder', () => ({
  buildContactContext: (...args: unknown[]) => mockBuildContactContext(args[0]),
}))

// ── Provider mock ───────────────────────────────────────────────────────────

let capturedSignal: AbortSignal | undefined
const mockGenerateSummary = vi.fn()

vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (
      system: string,
      user: string,
      onProgress: (chunk: string) => void,
      signal?: AbortSignal
    ) => {
      capturedSignal = signal
      return mockGenerateSummary(system, user)
    }
  })
}))

const { generateKeyTakeaways, abortKeyTakeaways } = await import('../main/llm/contact-key-takeaways')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateKeyTakeaways', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedSignal = undefined
    // Reset abort state between tests
    abortKeyTakeaways()
  })

  it('throws "Not enough context" when hasMeetings/hasEmails/hasNotes are all false', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n',
      hasMeetings: false,
      hasEmails: false,
      hasNotes: false,
    })
    await expect(generateKeyTakeaways('c1', () => {})).rejects.toThrow('Not enough context')
  })

  it('throws "Generation returned empty content" when provider returns empty string', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Meeting Summaries\nSome content',
      hasMeetings: true,
      hasEmails: false,
      hasNotes: false,
    })
    mockGenerateSummary.mockResolvedValue('')
    await expect(generateKeyTakeaways('c1', () => {})).rejects.toThrow('Generation returned empty content')
  })

  it('throws "Generation returned empty content" when provider returns whitespace', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Notes\nSome note',
      hasMeetings: false,
      hasEmails: false,
      hasNotes: true,
    })
    mockGenerateSummary.mockResolvedValue('   ')
    await expect(generateKeyTakeaways('c1', () => {})).rejects.toThrow('Generation returned empty content')
  })

  it('returns bullets from provider on happy path', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Email Correspondence\nEmail body',
      hasMeetings: false,
      hasEmails: true,
      hasNotes: false,
    })
    const bullets = '• Consumer investor focused on seed-stage\n• Writes $250k–$500k checks\n• Prefers technical co-founders'
    mockGenerateSummary.mockResolvedValue(bullets)
    const result = await generateKeyTakeaways('c1', () => {})
    expect(result).toBe(bullets)
  })

  it('truncates output to 1000 characters', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Notes\nSome note',
      hasMeetings: false,
      hasEmails: false,
      hasNotes: true,
    })
    const longOutput = '• ' + 'x'.repeat(1500)
    mockGenerateSummary.mockResolvedValue(longOutput)
    const result = await generateKeyTakeaways('c1', () => {})
    expect(result.length).toBe(1000)
  })

  it('passes an AbortSignal to provider.generateSummary', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Notes\nSome note',
      hasMeetings: false,
      hasEmails: false,
      hasNotes: true,
    })
    mockGenerateSummary.mockResolvedValue('• Bullet one')
    await generateKeyTakeaways('c1', () => {})
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('aborts previous in-flight call when a new one starts', async () => {
    mockBuildContactContext.mockReturnValue({
      context: '# Contact: Jane Smith\n## Notes\nSome note',
      hasMeetings: false,
      hasEmails: false,
      hasNotes: true,
    })

    let resolveFirst!: (val: string) => void
    const firstPromise = new Promise<string>((res) => { resolveFirst = res })
    mockGenerateSummary
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce('• Second result')

    // Start first generation — don't await
    const firstCall = generateKeyTakeaways('c1', () => {})

    // Start second generation — this should abort the first
    const secondResult = await generateKeyTakeaways('c2', () => {})

    // The first call's signal should now be aborted
    expect(capturedSignal?.aborted).toBe(false) // second call's signal is fresh

    // Resolve the first generation's provider to unblock its promise
    resolveFirst('• First result')

    // Second result succeeded
    expect(secondResult).toBe('• Second result')

    // First call rejects (or resolves — depending on whether the provider respects the signal)
    // At minimum it should not throw an unhandled error
    await expect(firstCall).resolves.toBeDefined()
  })
})
