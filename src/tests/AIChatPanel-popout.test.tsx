// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Regression test for the chat-panel pop-out handler.
 *
 *   Before fix: handlePopOut called setOpen(false) alongside setPopped(true).
 *   This added redundant state churn during the rail→fullscreen handoff and
 *   contributed to a render race that could white-screen the app.
 *
 *   After fix: only setPopped(true) is needed because Layout's render gate
 *   (useReflow = isOpen && !popped) already takes the rail out of the tree
 *   when popped flips. AIChatFullscreen also sets isOpen=true on mount, so
 *   the panel stays "open" semantically through the transition.
 *
 *   This test freezes that contract: re-adding setOpen(false) trips it.
 */

// CSS module shims — the production code uses these as object lookups; tests
// don't need real styles.
vi.mock('../renderer/components/chat-panel/AIChatPanel.module.css', () => ({
  default: {
    panel: 'panel',
    panelOverlay: 'panelOverlay',
    backdrop: 'backdrop',
    threadSlot: 'threadSlot',
    composerSlot: 'composerSlot',
  },
}))
vi.mock('../renderer/components/chat-panel/PanelHeader.module.css', () => ({
  default: {
    head: 'head',
    iconBtn: 'iconBtn',
    titleWrap: 'titleWrap',
    title: 'title',
    titleLink: 'titleLink',
    meta: 'meta',
    actions: 'actions',
    overflowWrap: 'overflowWrap',
    overflowMenu: 'overflowMenu',
    overflowItem: 'overflowItem',
  },
}))
vi.mock('../renderer/components/chat-panel/PanelSwitcher.module.css', () => ({ default: {} }))
vi.mock('../renderer/components/chat-panel/ResizeHandle.module.css', () => ({ default: {} }))

// Stub useNavigate so we can spy on the navigation argument without an
// actual router transition.
const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

// Stub api so AIChatPanel's recents fetch on mount doesn't hit IPC.
vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn().mockResolvedValue([]),
    on: vi.fn().mockReturnValue(() => {}),
    send: vi.fn(),
    once: vi.fn(),
    getPathForFile: vi.fn().mockReturnValue(null),
  },
}))

// Imports must come after the mocks above.
const { AIChatPanel } = await import('../renderer/components/chat-panel/AIChatPanel')
const { PanelOutletProvider } = await import('../renderer/components/chat-panel/PanelOutletContext')
const { useChatPanelStore, __resetChatPanelStore } = await import(
  '../renderer/stores/chat-panel.store'
)

function renderPanel() {
  return render(
    <MemoryRouter>
      <PanelOutletProvider>
        <AIChatPanel overlay={false} />
      </PanelOutletProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  __resetChatPanelStore()
  navigate.mockReset()
  // Seed the state pop-out depends on: a session is open and the panel is
  // open in thread mode (the ⤢ button only renders in thread mode).
  useChatPanelStore.setState({
    isOpen: true,
    mode: 'thread',
    openSessionId: 'session-1',
  })
})

afterEach(() => cleanup())

describe('AIChatPanel — pop-out (⤢)', () => {
  it('sets popped=true, leaves isOpen unchanged, and navigates to /ai-chats/:id', () => {
    const { getByLabelText } = renderPanel()
    const initialIsOpen = useChatPanelStore.getState().isOpen

    fireEvent.click(getByLabelText('Open full screen'))

    const state = useChatPanelStore.getState()
    expect(state.popped).toBe(true)
    // CRITICAL: isOpen must NOT flip. Re-introducing setOpen(false) trips this.
    expect(state.isOpen).toBe(initialIsOpen)
    expect(state.isOpen).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/ai-chats/session-1')
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('captures returnTo from the current location before navigating', () => {
    const { getByLabelText } = renderPanel()
    fireEvent.click(getByLabelText('Open full screen'))
    expect(useChatPanelStore.getState().returnTo).not.toBeNull()
  })

  it('is a no-op when no session is open', () => {
    useChatPanelStore.setState({ openSessionId: null })
    const { getByLabelText } = renderPanel()

    fireEvent.click(getByLabelText('Open full screen'))

    expect(useChatPanelStore.getState().popped).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
