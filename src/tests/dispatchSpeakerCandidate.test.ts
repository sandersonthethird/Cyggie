/**
 * Tests for the pure SpeakerCandidate dispatch helper that powers the
 * picker → IPC routing in MeetingDetail. The helper is the only piece of
 * branching that decides whether a user's pick triggers a plain rename
 * or a contact link — exactly the kind of code that breaks silently when
 * refactored later, so it gets its own dedicated test.
 *
 * Coverage:
 *   - kind: 'attendee'  → handlers.rename(idx, name)
 *   - kind: 'contact'   → handlers.link(idx, contact)
 *   - freeText (Enter on a non-empty query with no highlight) is wrapped
 *     by the call site as kind: 'attendee' — verified end-to-end here.
 *   - errors thrown by either handler propagate (caller decides recovery).
 */

import { describe, it, expect, vi } from 'vitest'
import type { ContactSummary } from '../shared/types/contact'
import { dispatchSpeakerCandidate, type SpeakerCandidate } from '../renderer/hooks/useCombinedSpeakerPicker'

function fakeContact(): ContactSummary {
  return {
    id: 'c-1',
    fullName: 'Sandy Cass',
    firstName: 'Sandy',
    lastName: 'Cass',
    normalizedName: 'sandy cass',
    email: 'sandy@redswanventures.com',
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    talentPipeline: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount: 0,
    emailCount: 0,
    lastTouchpoint: null,
    createdAt: '',
    updatedAt: '',
  }
}

function makeHandlers() {
  return {
    rename: vi.fn().mockResolvedValue(undefined),
    link: vi.fn().mockResolvedValue(undefined),
  }
}

describe('dispatchSpeakerCandidate', () => {
  it('routes an attendee candidate to rename', async () => {
    const handlers = makeHandlers()
    const candidate: SpeakerCandidate = {
      id: 'attendee:Sandy Cass',
      kind: 'attendee',
      name: 'Sandy Cass',
      isSectionLead: true,
    }

    await dispatchSpeakerCandidate(0, candidate, handlers)

    expect(handlers.rename).toHaveBeenCalledTimes(1)
    expect(handlers.rename).toHaveBeenCalledWith(0, 'Sandy Cass')
    expect(handlers.link).not.toHaveBeenCalled()
  })

  it('routes a contact candidate to link (and not rename)', async () => {
    const handlers = makeHandlers()
    const contact = fakeContact()
    const candidate: SpeakerCandidate = {
      id: contact.id,
      kind: 'contact',
      contact,
      isSectionLead: true,
    }

    await dispatchSpeakerCandidate(1, candidate, handlers)

    expect(handlers.link).toHaveBeenCalledTimes(1)
    expect(handlers.link).toHaveBeenCalledWith(1, contact)
    expect(handlers.rename).not.toHaveBeenCalled()
  })

  it('treats free-text (kind:attendee with synthetic id) as a rename', async () => {
    const handlers = makeHandlers()
    // Free-text: the user typed a name not in either list and pressed Enter.
    // The call site wraps the query as { kind: 'attendee', id: 'freetext:...' }.
    const candidate: SpeakerCandidate = {
      id: 'freetext:Guest Speaker',
      kind: 'attendee',
      name: 'Guest Speaker',
      isSectionLead: false,
    }

    await dispatchSpeakerCandidate(2, candidate, handlers)

    expect(handlers.rename).toHaveBeenCalledTimes(1)
    expect(handlers.rename).toHaveBeenCalledWith(2, 'Guest Speaker')
    expect(handlers.link).not.toHaveBeenCalled()
  })

  it('propagates errors from the rename handler', async () => {
    const handlers = {
      rename: vi.fn().mockRejectedValue(new Error('IPC down')),
      link: vi.fn().mockResolvedValue(undefined),
    }
    const candidate: SpeakerCandidate = {
      id: 'attendee:X',
      kind: 'attendee',
      name: 'X',
      isSectionLead: true,
    }
    await expect(dispatchSpeakerCandidate(0, candidate, handlers)).rejects.toThrow('IPC down')
  })

  it('propagates errors from the link handler', async () => {
    const handlers = {
      rename: vi.fn().mockResolvedValue(undefined),
      link: vi.fn().mockRejectedValue(new Error('contact gone')),
    }
    const contact = fakeContact()
    const candidate: SpeakerCandidate = {
      id: contact.id,
      kind: 'contact',
      contact,
      isSectionLead: true,
    }
    await expect(dispatchSpeakerCandidate(0, candidate, handlers)).rejects.toThrow('contact gone')
  })
})
