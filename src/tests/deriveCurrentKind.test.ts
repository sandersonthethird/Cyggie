/**
 * Regression test for the "Bobby Kwon couldn't be found" trap.
 *
 * Before the fix: clicking × on the "Including context: <Init Labs>" chip was
 * purely cosmetic — it hid the chip but the next message still routed through
 * COMPANY_CHAT_QUERY because deriveCurrentKind looked at panelSession.contextKind
 * before checking dismissedContextChips. Users on a company page who started a
 * new chat to ask about something else (a contact, a different company) got
 * silently company-scoped results.
 *
 * The dismissed-chip check is now priority 0 — it overrides everything else.
 */
import { describe, it, expect } from 'vitest'
import { deriveCurrentKind } from '../renderer/components/chat-panel/ChatPanelRoot'
import type { ContextOption, ChatPageContext } from '../shared/types/chat'

const NO_DISMISS = new Set<string>()

const COMPANY_OPT: ContextOption = { type: 'company', id: 'init-labs', name: 'Init Labs' }
const CONTACT_OPT: ContextOption = { type: 'contact', id: 'p1', name: 'Bobby Kwon' }

const COMPANY_SESSION = {
  sessionId: 'sess-1',
  contextId: 'company:init-labs',
  contextKind: 'company' as const,
}

describe('deriveCurrentKind — dismissed-chip override (regression)', () => {
  it('routes through global when the user dismissed the chip on a company-scoped session', () => {
    const dismissed = new Set([COMPANY_SESSION.sessionId])
    const kind = deriveCurrentKind({
      contextOptions: [COMPANY_OPT],
      activeContextId: COMPANY_OPT.id,
      panelSession: COMPANY_SESSION,
      pageContext: { contextOptions: [COMPANY_OPT] },
      dismissedContextChips: dismissed,
    })
    expect(kind).toEqual({ kind: 'global' })
  })

  it('routes through company when chip is NOT dismissed (the default)', () => {
    const kind = deriveCurrentKind({
      contextOptions: [COMPANY_OPT],
      activeContextId: COMPANY_OPT.id,
      panelSession: COMPANY_SESSION,
      pageContext: { contextOptions: [COMPANY_OPT] },
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'company', companyId: 'init-labs' })
  })

  it('explicit chip selection wins over panelSession when not dismissed', () => {
    const kind = deriveCurrentKind({
      contextOptions: [CONTACT_OPT],
      activeContextId: CONTACT_OPT.id,
      panelSession: COMPANY_SESSION,
      pageContext: null,
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'contact', contactId: 'p1' })
  })

  it('falls through to panelSession kind when no chip is selected', () => {
    const kind = deriveCurrentKind({
      contextOptions: [],
      activeContextId: null,
      panelSession: COMPANY_SESSION,
      pageContext: null,
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'company', companyId: 'init-labs' })
  })

  it('falls through to pageContext.meetingId when no panelSession', () => {
    const pageContext: ChatPageContext = { meetingId: 'm1' }
    const kind = deriveCurrentKind({
      contextOptions: [],
      activeContextId: null,
      panelSession: null,
      pageContext,
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'meeting', meetingId: 'm1' })
  })

  it('falls through to pageContext.meetingIds (search results) when no panelSession', () => {
    const pageContext: ChatPageContext = { meetingIds: ['a', 'b'] }
    const kind = deriveCurrentKind({
      contextOptions: [],
      activeContextId: null,
      panelSession: null,
      pageContext,
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'meetings', meetingIds: ['a', 'b'] })
  })

  it('falls back to global when there is nothing to route on', () => {
    const kind = deriveCurrentKind({
      contextOptions: [],
      activeContextId: null,
      panelSession: null,
      pageContext: null,
      dismissedContextChips: NO_DISMISS,
    })
    expect(kind).toEqual({ kind: 'global' })
  })

  it('dismissed-chip override beats explicit chip selection too', () => {
    // Even if the user has selected a contact in the chip dropdown, dismissing
    // the chip (the × button) should win and route through global.
    const dismissed = new Set([COMPANY_SESSION.sessionId])
    const kind = deriveCurrentKind({
      contextOptions: [CONTACT_OPT],
      activeContextId: CONTACT_OPT.id,
      panelSession: COMPANY_SESSION,
      pageContext: null,
      dismissedContextChips: dismissed,
    })
    expect(kind).toEqual({ kind: 'global' })
  })
})
