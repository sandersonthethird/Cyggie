import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatSessionListItem } from '../../lib/api/chat'

// ChatComposer is dual-mode: given a `sessionId` it resumes THAT exact session
// (loads detail by id, skips find-or-create); without one it opens/creates the
// context's active session. The worst failure of the resume path is silent —
// resuming the active session instead of the one the user tapped would show a
// plausible-but-wrong conversation. These two tests pin the branch.

const mockCreateOrGet = jest.fn()
const mockFetchSession = jest.fn()
jest.mock('../../lib/api/chat', () => ({
  createOrGetChatSession: (...args: unknown[]) => mockCreateOrGet(...args),
  fetchChatSession: (...args: unknown[]) => mockFetchSession(...args),
  sendSessionMessageStream: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChatComposer } = require('../ChatComposer')

function makeSession(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-x',
    contextId: 'company:co-1',
    contextKind: 'company',
    contextLabel: 'Acme Inc',
    title: null,
    previewText: null,
    messageCount: 0,
    isPinned: false,
    isArchived: false,
    isActive: true,
    lastMessageAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    lamport: '1',
    selectedCompanyIds: [],
    cacheEnabled: true,
    ...over,
  }
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  mockCreateOrGet.mockReset()
  mockFetchSession.mockReset()
})

describe('ChatComposer session resolution', () => {
  test('resume mode (sessionId) loads detail by id and does NOT find-or-create', async () => {
    mockFetchSession.mockResolvedValue({
      session: makeSession({ id: 'sess-123' }),
      messages: [],
      selectedCompanies: [],
    })

    wrap(
      <ChatComposer
        contextKind="company"
        contextId="company:co-1"
        sessionId="sess-123"
      />,
    )

    await waitFor(() =>
      expect(mockFetchSession).toHaveBeenCalledWith('sess-123', expect.anything()),
    )
    expect(mockCreateOrGet).not.toHaveBeenCalled()
  })

  test('default mode (no sessionId) find-or-creates the active session', async () => {
    mockCreateOrGet.mockResolvedValue(makeSession({ id: 'active-1' }))
    mockFetchSession.mockResolvedValue({
      session: makeSession({ id: 'active-1' }),
      messages: [],
      selectedCompanies: [],
    })

    wrap(<ChatComposer contextKind="company" contextId="company:co-1" />)

    await waitFor(() => expect(mockCreateOrGet).toHaveBeenCalledTimes(1))
    expect(mockCreateOrGet).toHaveBeenCalledWith({
      contextKind: 'company',
      contextId: 'company:co-1',
    })
  })
})
