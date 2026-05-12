import { describe, it, expect, vi } from 'vitest'

// All side-effect-heavy modules are mocked. We only want to verify the
// orchestrator's entry-path behavior here (e.g. failing fast when the
// Claude API key is missing). Full end-to-end coverage of the producer
// agent — with simulated tool_use/tool_result loops against a fixture DB —
// is a follow-up (tracked in TODOS.md).

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(() => null),
}))
vi.mock('../main/database/repositories/settings.repo', () => ({
  getSetting: vi.fn(() => null),
}))
vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: vi.fn(),
  listCompanyMeetings: vi.fn(() => []),
  listCompanyMeetingSummaryPaths: vi.fn(() => []),
  listCompanyContacts: vi.fn(() => []),
  listCompanyEmails: vi.fn(() => []),
}))
vi.mock('../main/database/repositories/investment-memo.repo', () => ({
  getMemoLatestVersion: vi.fn(() => null),
}))
vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: vi.fn(),
}))
vi.mock('../main/database/repositories/company-file-flags.repo', () => ({
  getFlaggedFiles: vi.fn(() => []),
}))
vi.mock('../main/database/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: vi.fn(() => []) }),
}))
vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
  readTranscript: vi.fn(),
}))
vi.mock('../main/database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  }),
}))
vi.mock('../main/services/exa-research', () => ({
  searchCompanyContext: vi.fn(() => Promise.resolve({ queries: [], results: [] })),
}))

import { runMemoProducerAgent } from '../main/llm/agents/memo-producer-agent'

describe('runMemoProducerAgent', () => {
  it('fails fast with AuthenticationError when no Claude API key is configured', async () => {
    const result = await runMemoProducerAgent({
      runId: 'r1',
      companyId: 'company-1',
      memoId: 'memo-1',
      userId: 'user-1',
      signal: new AbortController().signal,
      emit: vi.fn(),
    })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('AuthenticationError')
    expect(result.errorMessage).toContain('API key')
    expect(result.resultVersionId).toBe(null)
    expect(result.sectionsSubmitted).toEqual([])
  })
})
