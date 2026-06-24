import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatSessionListItem } from '../../lib/api/chat'

// CompanyRecentChats is the collapsible "recent chats" section at the top of a
// company chat screen. The logic worth pinning: it (1) excludes the
// currently-open session, (2) caps the list at 5, (3) renders nothing on
// empty/error (the section must never block the chat surface), and (4)
// resumes a tapped chat BY ID (router.push carries sessionId). The last one
// guards the silent "opened the wrong chat" failure.

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}))

const mockFetch = jest.fn()
jest.mock('../../lib/api/chat', () => ({
  fetchChatSessions: (...args: unknown[]) => mockFetch(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CompanyRecentChats } = require('../CompanyRecentChats')

const CONTEXT_ID = 'company:co-1'

function makeSession(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-x',
    contextId: CONTEXT_ID,
    contextKind: 'company',
    contextLabel: 'Acme Inc',
    title: 'A chat',
    previewText: null,
    messageCount: 3,
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

function renderSection(
  props: Partial<React.ComponentProps<typeof CompanyRecentChats>> = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CompanyRecentChats
        contextId={CONTEXT_ID}
        collapsed={false}
        onToggle={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockPush.mockClear()
  mockFetch.mockReset()
})

describe('CompanyRecentChats', () => {
  test('excludes the currently-open session from the list', async () => {
    mockFetch.mockResolvedValue({
      sessions: [
        makeSession({ id: 'current', title: 'Open now' }),
        makeSession({ id: 'prior-a', title: 'Prior A' }),
      ],
      total: 2,
    })

    renderSection({ currentSessionId: 'current' })

    expect(await screen.findByText('Prior A')).toBeOnTheScreen()
    expect(screen.queryByText('Open now')).toBeNull()
  })

  test('caps the rendered list at 5 prior chats', async () => {
    mockFetch.mockResolvedValue({
      sessions: Array.from({ length: 6 }, (_, i) =>
        makeSession({ id: `s${i}`, title: `Chat ${i}` }),
      ),
      total: 6,
    })

    renderSection()

    // The header reflects the capped count, and the 6th row is dropped.
    expect(await screen.findByText('Recent chats · 5')).toBeOnTheScreen()
    expect(screen.getByText('Chat 4')).toBeOnTheScreen()
    expect(screen.queryByText('Chat 5')).toBeNull()
  })

  test('renders nothing when there are no prior chats', async () => {
    mockFetch.mockResolvedValue({ sessions: [], total: 0 })

    renderSection()

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(screen.queryByText(/Recent chats/)).toBeNull()
  })

  test('renders nothing and warns when the query errors (never blocks the chat)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch.mockRejectedValue(new Error('boom'))

    renderSection()

    await waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(screen.queryByText(/Recent chats/)).toBeNull()
    warnSpy.mockRestore()
  })

  test('tapping a row resumes that exact session by id (router.push carries sessionId)', async () => {
    mockFetch.mockResolvedValue({
      sessions: [makeSession({ id: 'prior-a', title: 'Prior A' })],
      total: 1,
    })

    renderSection()

    fireEvent.press(await screen.findByLabelText('Open chat: Prior A'))
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/chat/[contextKind]/[contextId]',
      params: {
        contextKind: 'company',
        contextId: CONTEXT_ID,
        sessionId: 'prior-a',
        label: 'Prior A',
      },
    })
  })

  test('collapsed hides the rows but keeps the header', async () => {
    mockFetch.mockResolvedValue({
      sessions: [makeSession({ id: 'prior-a', title: 'Prior A' })],
      total: 1,
    })

    renderSection({ collapsed: true })

    expect(await screen.findByText('Recent chats · 1')).toBeOnTheScreen()
    expect(screen.queryByText('Prior A')).toBeNull()
  })
})
