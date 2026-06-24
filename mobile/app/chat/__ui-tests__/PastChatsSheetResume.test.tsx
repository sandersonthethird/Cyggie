import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatSessionListItem } from '../../../lib/api/chat'

// Regression guard for the global past-chats sheet: tapping a past chat must
// resume THAT exact session by id. Before the fix it navigated by contextId
// only, which silently reopened the context's *active* session instead of the
// row the user tapped.

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}))

const mockFetchSessions = jest.fn()
jest.mock('../../../lib/api/chat', () => ({
  fetchChatSessions: (...args: unknown[]) => mockFetchSessions(...args),
  // Other exports are imported at module load by chat/index.tsx + its
  // children but never invoked while rendering only the sheet.
  createOrGetChatSession: jest.fn(),
  fetchChatSession: jest.fn(),
  updateChatSession: jest.fn(),
  sendSessionMessageStream: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PastChatsSheet } = require('../index')

function makeSession(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-x',
    contextId: 'company:co-1',
    contextKind: 'company',
    contextLabel: 'Acme Inc',
    title: 'Pricing questions',
    previewText: null,
    messageCount: 4,
    isPinned: false,
    isArchived: false,
    isActive: false,
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
  mockPush.mockClear()
  mockFetchSessions.mockReset()
})

test('tapping a non-crm past chat resumes it by session id', async () => {
  mockFetchSessions.mockResolvedValue({
    sessions: [makeSession({ id: 'prior-42', title: 'Pricing questions' })],
    total: 1,
  })

  wrap(<PastChatsSheet open onClose={() => {}} />)

  fireEvent.press(await screen.findByLabelText('Open chat: Pricing questions'))

  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/chat/[contextKind]/[contextId]',
    params: {
      contextKind: 'company',
      contextId: 'company:co-1',
      sessionId: 'prior-42',
      label: 'Pricing questions',
    },
  })
})
