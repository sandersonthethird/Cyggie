// @vitest-environment jsdom

import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The panel pulls in a portal context, recents fetch, child header/switcher
// and a drag-resize handle — none of which are under test here. Stub them so
// the test isolates AIChatPanel's own prop-driven branches (backdrop,
// resize handle, inline width, closing class).
vi.mock('../PanelHeader', () => ({ PanelHeader: () => <div data-testid="panel-header" /> }))
vi.mock('../PanelSwitcher', () => ({ PanelSwitcher: () => <div data-testid="panel-switcher" /> }))
vi.mock('../ResizeHandle', () => ({ ResizeHandle: () => <div data-testid="resize-handle" /> }))
vi.mock('../PanelOutletContext', () => ({
  usePanelOutlet: () => ({ setThreadEl: vi.fn(), setComposerEl: vi.fn() }),
}))
vi.mock('../../../hooks/useChatActions', () => ({
  useChatActions: () => ({ pin: vi.fn(), archive: vi.fn(), delete: vi.fn(), rename: vi.fn() }),
}))
vi.mock('../../../api', () => ({ api: { invoke: vi.fn().mockResolvedValue([]) } }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

import { AIChatPanel } from '../AIChatPanel'
import { __resetChatPanelStore } from '../../../stores/chat-panel.store'

beforeEach(() => {
  __resetChatPanelStore()
})

afterEach(() => {
  cleanup()
})

const panel = () => screen.getByLabelText('AI Chat panel')
const backdrop = () => document.querySelector('[aria-hidden="true"]')

describe('AIChatPanel — overlay prop matrix', () => {
  test('desktop (dimmed=F, resizable=T, width): no backdrop, resize handle, inline width', () => {
    render(<AIChatPanel closing={false} dimmed={false} resizable width={420} />)

    expect(backdrop()).toBeNull()
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument()
    expect((panel() as HTMLElement).style.width).toBe('420px')
  })

  test('narrow (dimmed=T, resizable=F, no width): backdrop shown, no handle, width unset', () => {
    render(<AIChatPanel closing={false} dimmed resizable={false} onBackdropTap={vi.fn()} />)

    expect(backdrop()).not.toBeNull()
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument()
    // No inline width — CSS supplies the narrow default (min(88%, 360px)).
    expect((panel() as HTMLElement).style.width).toBe('')
  })

  test('backdrop tap invokes onBackdropTap', () => {
    const onBackdropTap = vi.fn()
    render(<AIChatPanel closing={false} dimmed resizable={false} onBackdropTap={onBackdropTap} />)

    fireEvent.click(backdrop() as Element)
    expect(onBackdropTap).toHaveBeenCalledOnce()
  })

  test('closing=true applies the slide-out modifier to the panel', () => {
    const { rerender } = render(<AIChatPanel closing={false} dimmed={false} resizable width={420} />)
    const classWhenOpen = panel().className

    rerender(<AIChatPanel closing dimmed={false} resizable width={420} />)
    const classWhenClosing = panel().className

    // The closing modifier adds a class, so the className string changes.
    expect(classWhenClosing).not.toBe(classWhenOpen)
  })
})
