/**
 * deriveCurrentKind — unified multi-entity routing.
 *
 * Chat routing is driven by the session's persisted attached-entity list:
 *   0 entities → global, ≥1 → entities (deduped multi-entity context). The
 * list overrides routing but never changes the session's contextId/contextKind
 * anchor. Removing every chip yields the empty-list → global state (this
 * replaced the old transient "dismissed chip" hack and the per-entity
 * company/contact kinds).
 */
import { describe, it, expect } from 'vitest'
import { deriveCurrentKind, deriveChatForNewChat } from '../renderer/components/chat-panel/ChatPanelRoot'
import type { ContextOption, ChatPageContext, AttachedContextEntity } from '../shared/types/chat'

const COMPANY_OPT: ContextOption = { type: 'company', id: 'init-labs', name: 'Init Labs' }
const COMPANY_ENT: AttachedContextEntity = { type: 'company', id: 'init-labs', label: 'Init Labs' }
const CONTACT_ENT: AttachedContextEntity = { type: 'contact', id: 'p1', label: 'Bobby Kwon' }

function session(attachedEntities: AttachedContextEntity[], over: Partial<{ contextId: string; contextKind: 'company' | 'contact' | 'meeting' | 'global'; contextLabel: string | null }> = {}) {
  return {
    sessionId: 'sess-1',
    contextId: over.contextId ?? 'company:init-labs',
    contextKind: over.contextKind ?? ('company' as const),
    contextLabel: over.contextLabel ?? 'Init Labs',
    attachedEntities,
  }
}

describe('deriveCurrentKind — unified multi-entity routing', () => {
  it('routes a single attached entity through the entities kind', () => {
    const kind = deriveCurrentKind({ panelSession: session([COMPANY_ENT]), pageContext: null })
    expect(kind).toEqual({
      kind: 'entities',
      refs: [COMPANY_ENT],
      contextId: 'company:init-labs',
      contextKind: 'company',
      contextLabel: 'Init Labs',
    })
  })

  it('routes multiple attached entities through the entities kind, preserving order', () => {
    const kind = deriveCurrentKind({ panelSession: session([COMPANY_ENT, CONTACT_ENT]), pageContext: null })
    expect(kind).toMatchObject({ kind: 'entities', refs: [COMPANY_ENT, CONTACT_ENT] })
  })

  it('routes to global when the attached list is empty (all chips removed)', () => {
    const kind = deriveCurrentKind({ panelSession: session([]), pageContext: { contextOptions: [COMPANY_OPT] } })
    expect(kind).toEqual({ kind: 'global' })
  })

  it('a meeting-anchored session with no chips routes to meeting with empty refs', () => {
    const kind = deriveCurrentKind({
      panelSession: session([], { contextId: 'm1', contextKind: 'meeting' }),
      pageContext: null,
    })
    expect(kind).toEqual({ kind: 'meeting', meetingId: 'm1', refs: [] })
  })

  it('a meeting-anchored session surfaces its attached entities as refs (+ Add context)', () => {
    const kind = deriveCurrentKind({
      panelSession: session([COMPANY_ENT], { contextId: 'm1', contextKind: 'meeting' }),
      pageContext: null,
    })
    expect(kind).toEqual({ kind: 'meeting', meetingId: 'm1', refs: [COMPANY_ENT] })
  })

  it('seeds the entities kind from the page entity before a session exists', () => {
    const kind = deriveCurrentKind({ panelSession: null, pageContext: { contextOptions: [COMPANY_OPT] } })
    expect(kind).toEqual({
      kind: 'entities',
      refs: [{ type: 'company', id: 'init-labs', label: 'Init Labs' }],
      contextId: 'company:init-labs',
      contextKind: 'company',
      contextLabel: 'Init Labs',
    })
  })

  it('falls through to pageContext.meetingId when no panelSession', () => {
    const pageContext: ChatPageContext = { meetingId: 'm1' }
    const kind = deriveCurrentKind({ panelSession: null, pageContext })
    expect(kind).toEqual({ kind: 'meeting', meetingId: 'm1' })
  })

  it('on a meeting page, the meeting wins over its linked company options (no session)', () => {
    // Regression: a meeting linked to a company used to anchor the chat on the
    // company, so the meeting transcript was never in context. The meeting must win.
    const pageContext: ChatPageContext = { meetingId: 'm1', contextOptions: [COMPANY_OPT] }
    const kind = deriveCurrentKind({ panelSession: null, pageContext })
    expect(kind).toEqual({ kind: 'meeting', meetingId: 'm1' })
  })

  it('falls through to pageContext.meetingIds (search results) when no panelSession', () => {
    const pageContext: ChatPageContext = { meetingIds: ['a', 'b'] }
    const kind = deriveCurrentKind({ panelSession: null, pageContext })
    expect(kind).toEqual({ kind: 'meetings', meetingIds: ['a', 'b'] })
  })

  it('falls back to global when there is nothing to route on', () => {
    const kind = deriveCurrentKind({ panelSession: null, pageContext: null })
    expect(kind).toEqual({ kind: 'global' })
  })
})

describe('deriveChatForNewChat — "+ New chat" anchor from the current page', () => {
  it('anchors a new chat on the meeting, NOT its linked company', () => {
    // Core fix: "+ New chat" on a meeting detail page must start a meeting chat
    // (full transcript/notes), even when the meeting is linked to a company.
    const ctx = deriveChatForNewChat({ meetingId: 'm1', contextOptions: [COMPANY_OPT] })
    expect(ctx).toEqual({ contextId: 'm1', contextKind: 'meeting', contextLabel: null })
  })

  it('anchors on the company when the page has no meeting (company/contact page)', () => {
    const ctx = deriveChatForNewChat({ contextOptions: [COMPANY_OPT] })
    expect(ctx).toEqual({ contextId: 'company:init-labs', contextKind: 'company', contextLabel: 'Init Labs' })
  })

  it('anchors on the meeting when the page is a bare meeting (no linked entities)', () => {
    const ctx = deriveChatForNewChat({ meetingId: 'm1' })
    expect(ctx).toEqual({ contextId: 'm1', contextKind: 'meeting', contextLabel: null })
  })

  it('falls back to global with no page context', () => {
    const ctx = deriveChatForNewChat(null)
    expect(ctx).toEqual({ contextId: 'global-all', contextKind: 'global', contextLabel: null })
  })
})
