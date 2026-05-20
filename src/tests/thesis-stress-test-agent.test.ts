import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stress-test agent doesn't have an early-return after auth (unlike the
// producer agent), so we mock runAgentLoop to a quick stub. We're only
// verifying the auth handling + key fallback here.

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(() => null),
}))

vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: vi.fn(() => null),
}))

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  }),
}))

vi.mock('@cyggie/services/llm/agents/agent-loop', () => ({
  runAgentLoop: vi.fn(),
}))

import { runStressTestAgent } from '@cyggie/services/llm/agents/thesis-stress-test-agent'
import { getCredential } from '../main/security/credentials'
import { runAgentLoop } from '@cyggie/services/llm/agents/agent-loop'

const mockedGetCredential = vi.mocked(getCredential)
const runAgentLoopMock = vi.mocked(runAgentLoop)

const STUB_LOOP_RESULT = {
  status: 'success' as const,
  terminalToolInput: undefined,
  iterations: 0,
  inputTokensTotal: 0,
  outputTokensTotal: 0,
  cacheReadTokensTotal: 0,
  cacheCreateTokensTotal: 0,
  costEstimateUsd: 0,
  toolCallCount: 0,
  webSearchCount: 0,
  durationMs: 0,
}

function runAgent() {
  return runStressTestAgent({
    runId: 'r1',
    companyId: 'company-1',
    companyName: 'Test Co',
    userId: 'user-1',
    existingMemoMarkdown: '# Memo',
    signal: new AbortController().signal,
    emit: vi.fn(),
  })
}

describe('runStressTestAgent', () => {
  beforeEach(() => {
    mockedGetCredential.mockReset()
    runAgentLoopMock.mockReset()
    runAgentLoopMock.mockResolvedValue(STUB_LOOP_RESULT)
  })

  it('fails fast with AuthenticationError when no Claude API key is configured', async () => {
    mockedGetCredential.mockReturnValue(null)
    const result = await runAgent()
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('AuthenticationError')
    // New error message mentions both keys so the user knows the override exists.
    expect(result.errorMessage).toContain('main Anthropic key')
    expect(result.errorMessage).toContain('memo-specific override')
    // Auth check must short-circuit before we hit the loop.
    expect(runAgentLoopMock).not.toHaveBeenCalled()
  })

  // ─── Key fallback behavior (memoApiKey || claudeApiKey) ──────────────────
  // memoApiKey takes precedence; if unset, agent falls back to claudeApiKey.
  // Past the auth check the agent calls runAgentLoop, which we've stubbed.

  it('uses memoApiKey when set and does not read claudeApiKey', async () => {
    mockedGetCredential.mockImplementation((key) => {
      if (key === 'memoApiKey') return 'mk-memo-test'
      if (key === 'claudeApiKey') return 'ck-main-test'
      return null
    })

    await runAgent()

    // Past auth → runAgentLoop must have been called.
    expect(runAgentLoopMock).toHaveBeenCalledOnce()

    const callArgs = mockedGetCredential.mock.calls.map((c) => c[0])
    expect(callArgs).toContain('memoApiKey')
    // Short-circuit: claudeApiKey should NOT have been queried.
    expect(callArgs).not.toContain('claudeApiKey')
  })

  it('falls back to claudeApiKey when memoApiKey is null', async () => {
    mockedGetCredential.mockImplementation((key) => {
      if (key === 'memoApiKey') return null
      if (key === 'claudeApiKey') return 'ck-main-test'
      return null
    })

    await runAgent()

    // Past auth → runAgentLoop must have been called.
    expect(runAgentLoopMock).toHaveBeenCalledOnce()

    const callArgs = mockedGetCredential.mock.calls.map((c) => c[0])
    const memoIdx = callArgs.indexOf('memoApiKey')
    const claudeIdx = callArgs.indexOf('claudeApiKey')
    expect(memoIdx).toBeGreaterThanOrEqual(0)
    expect(claudeIdx).toBeGreaterThan(memoIdx)
  })
})
