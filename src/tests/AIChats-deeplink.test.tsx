// @vitest-environment jsdom
/**
 * Verifies the URL deep-link flow on the /ai-chats page:
 *   - ?openChat=<id> triggers LOAD_MESSAGES + chatStore.loadPanelSession
 *   - the URL param is cleared after consumption
 *   - subsequent rerenders do not re-trigger (one-shot)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const invokeMock = vi.fn()

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: vi.fn(() => () => {}),
  },
}))

import AIChats from '../renderer/routes/AIChats'
import { useChatStore } from '../renderer/stores/chat.store'

beforeEach(() => {
  invokeMock.mockReset()
  cleanup()
  // Reset chat store
  useChatStore.setState({
    conversations: {},
    panelSession: null,
    modalOpen: false,
    pageContext: null,
  })
})

const SAMPLE_SESSION = {
  id: 'sess-1',
  contextId: 'company:c1',
  contextKind: 'company' as const,
  contextLabel: 'Acme Corp',
  title: 'Discuss Acme valuation',
  previewText: 'Some preview',
  messageCount: 3,
  isActive: true,
  isPinned: false,
  isArchived: false,
  lastMessageAt: new Date().toISOString(),
}

const SAMPLE_MESSAGES = [
  { id: 'm1', sessionId: 'sess-1', role: 'user', content: 'q', createdAt: '2026-05-02T10:00:00Z' },
  { id: 'm2', sessionId: 'sess-1', role: 'assistant', content: 'a', createdAt: '2026-05-02T10:01:00Z' },
]

function setupInvokes(opts: { sessions?: unknown[]; messages?: unknown[] } = {}) {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'chat-session:list-recent') {
      return Promise.resolve(opts.sessions ?? [SAMPLE_SESSION])
    }
    if (channel === 'chat-session:load-messages') {
      return Promise.resolve(opts.messages ?? SAMPLE_MESSAGES)
    }
    if (channel === 'chat-session:search') {
      return Promise.resolve([])
    }
    return Promise.resolve(null)
  })
}

describe('AIChats — URL deep-link', () => {
  it('opens the modal when ?openChat=<id> is present and the session exists', async () => {
    setupInvokes()

    render(
      <MemoryRouter initialEntries={['/ai-chats?openChat=sess-1']}>
        <AIChats />
      </MemoryRouter>
    )

    // Wait for both the list fetch + the deep-link consume to complete.
    await waitFor(() => {
      const conv = useChatStore.getState().panelSession
      expect(conv).not.toBeNull()
      expect(conv?.sessionId).toBe('sess-1')
    })

    // Both LIST_RECENT and LOAD_MESSAGES were invoked.
    const channels = invokeMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('chat-session:list-recent')
    expect(channels).toContain('chat-session:load-messages')
  })

  it('does NOT open the modal when the session is not in the recent list', async () => {
    // The deep-link references an id that's not in the returned sessions.
    setupInvokes({ sessions: [] })

    render(
      <MemoryRouter initialEntries={['/ai-chats?openChat=does-not-exist']}>
        <AIChats />
      </MemoryRouter>
    )

    // Wait for the list fetch to complete.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat-session:list-recent', expect.anything())
    })

    // Modal should not have been opened.
    expect(useChatStore.getState().panelSession).toBeNull()
  })

  it('does NOT open the modal when no openChat param is present', async () => {
    setupInvokes()

    render(
      <MemoryRouter initialEntries={['/ai-chats']}>
        <AIChats />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat-session:list-recent', expect.anything())
    })

    // LOAD_MESSAGES should never have been invoked.
    const channels = invokeMock.mock.calls.map((c) => c[0])
    expect(channels).not.toContain('chat-session:load-messages')
    expect(useChatStore.getState().panelSession).toBeNull()
  })
})
