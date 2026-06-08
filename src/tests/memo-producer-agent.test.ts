import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubModule } from './_fixtures/mock-module'

// All side-effect-heavy modules are mocked. We only want to verify the
// orchestrator's entry-path behavior here (auth handling, key fallback)
// without doing full end-to-end coverage of the producer agent's tool loop.

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(() => null),
}))
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: vi.fn(() => null),
}))
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () =>
  stubModule({
    getCompany: vi.fn(),
    listCompanyMeetings: vi.fn(() => []),
    listCompanyMeetingSummaryPaths: vi.fn(() => []),
    listCompanyContacts: vi.fn(() => []),
    listCompanyEmails: vi.fn(() => []),
  })
)
vi.mock('@cyggie/db/sqlite/repositories/investment-memo.repo', () =>
  stubModule({
    getMemoLatestVersion: vi.fn(() => null),
  })
)
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () =>
  stubModule({
    getMeeting: vi.fn(),
  })
)
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () =>
  stubModule({
    getFlaggedFiles: vi.fn(() => []),
  })
)
vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: vi.fn(() => []) }),
}))
vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
  readTranscript: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  }),
}))
vi.mock('@cyggie/services/exa-research', () => ({
  searchCompanyContext: vi.fn(() => Promise.resolve({ queries: [], results: [] })),
}))

import { runMemoProducerAgent } from '@cyggie/services/llm/agents/memo-producer-agent'
import { getCredential } from '../main/security/credentials'

const mockedGetCredential = vi.mocked(getCredential)

function runAgent() {
  return runMemoProducerAgent({
    runId: 'r1',
    companyId: 'company-1',
    memoId: 'memo-1',
    userId: 'user-1',
    signal: new AbortController().signal,
    emit: vi.fn(),
  })
}

describe('runMemoProducerAgent', () => {
  beforeEach(() => {
    mockedGetCredential.mockReset()
  })

  it('fails fast with AuthenticationError when no Claude API key is configured', async () => {
    mockedGetCredential.mockReturnValue(null)
    const result = await runAgent()
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('AuthenticationError')
    // New error message mentions both keys so the user knows the override exists.
    expect(result.errorMessage).toContain('main Anthropic key')
    expect(result.errorMessage).toContain('memo-specific override')
    expect(result.resultVersionId).toBe(null)
    expect(result.sectionsSubmitted).toEqual([])
  })

  // ─── Key fallback behavior (memoApiKey || claudeApiKey) ──────────────────
  // The agent reads memoApiKey first; if set, it short-circuits and never
  // touches claudeApiKey. If memoApiKey is null, it falls back to claudeApiKey.
  // Past the auth check the agent fails downstream with CompanyNotFound
  // (getCompany mock returns undefined), which we use as the "auth passed"
  // signal — we don't need to wire up a full success path.

  it('uses memoApiKey when set and does not read claudeApiKey', async () => {
    mockedGetCredential.mockImplementation((key) => {
      if (key === 'memoApiKey') return 'mk-memo-test'
      if (key === 'claudeApiKey') return 'ck-main-test'
      return null
    })

    const result = await runAgent()

    // Past auth, so should fail with CompanyNotFound (not AuthenticationError).
    expect(result.errorClass).toBe('CompanyNotFound')

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

    const result = await runAgent()

    // Past auth, so should fail with CompanyNotFound (not AuthenticationError).
    expect(result.errorClass).toBe('CompanyNotFound')

    const callArgs = mockedGetCredential.mock.calls.map((c) => c[0])
    // Both keys queried, in the correct order.
    const memoIdx = callArgs.indexOf('memoApiKey')
    const claudeIdx = callArgs.indexOf('claudeApiKey')
    expect(memoIdx).toBeGreaterThanOrEqual(0)
    expect(claudeIdx).toBeGreaterThan(memoIdx)
  })
})
