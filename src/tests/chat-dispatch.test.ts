/**
 * Tests for chat-dispatch.ts — the single entry point routing each ChatKind
 * to its existing query* function.
 *
 *   What this exercises:
 *     1. Dispatch table: each kind routes to the right query* function with
 *        the right args.
 *     2. never-guard throws TypeError on an unknown kind (compile-time
 *        protection at runtime is also useful for tests with `as any`).
 *     3. abortChatDispatch delegates to abortChatTurn.
 *     4. attachments default to [] when undefined (preserves the legacy
 *        signatures of queryMeeting / querySearchResults / queryAll).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatAttachment } from '../shared/types/chat'

// ── Mocks for each query* function ─────────────────────────────────────

const mockQueryMeeting = vi.fn()
const mockQuerySearchResults = vi.fn()
const mockQueryCompany = vi.fn()
const mockQueryContact = vi.fn()
const mockQueryAll = vi.fn()
const mockAbortChatTurn = vi.fn()

vi.mock('../main/llm/chat', () => ({
  queryMeeting: (...args: unknown[]) => mockQueryMeeting(...args),
  querySearchResults: (...args: unknown[]) => mockQuerySearchResults(...args),
  // Other exports unused by chat-dispatch.ts.
  buildMeetingContext: () => '',
  abortChat: () => {},
  injectTextAttachments: (q: string) => q,
}))

vi.mock('../main/llm/company-chat', () => ({
  queryCompany: (...args: unknown[]) => mockQueryCompany(...args),
  abortCompanyChat: () => {},
}))

vi.mock('../main/llm/contact-chat', () => ({
  queryContact: (...args: unknown[]) => mockQueryContact(...args),
  abortContactChat: () => {},
}))

vi.mock('../main/llm/crm-chat', () => ({
  queryAll: (...args: unknown[]) => mockQueryAll(...args),
  queryCrm: () => Promise.resolve(''),
  abortAllChat: () => {},
  buildCrmContext: () => Promise.resolve(''),
}))

vi.mock('../main/llm/chat-runner', () => ({
  abortChatTurn: () => mockAbortChatTurn(),
}))

const { chatDispatch, abortChatDispatch } = await import('../main/llm/chat-dispatch')

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryMeeting.mockResolvedValue('meeting-response')
  mockQuerySearchResults.mockResolvedValue('search-response')
  mockQueryCompany.mockResolvedValue('company-response')
  mockQueryContact.mockResolvedValue('contact-response')
  mockQueryAll.mockResolvedValue('global-response')
})

// ── Routing per kind ───────────────────────────────────────────────────

describe('chatDispatch — routing', () => {
  it('routes meeting → queryMeeting with (id, question, attachments)', async () => {
    const atts: ChatAttachment[] = [
      { name: 'file.txt', mimeType: 'text/plain', type: 'text', data: 'body' },
    ]
    const result = await chatDispatch({
      kind: { kind: 'meeting', meetingId: 'm1' },
      question: 'q?',
      attachments: atts,
    })
    expect(result).toBe('meeting-response')
    expect(mockQueryMeeting).toHaveBeenCalledWith('m1', 'q?', atts)
  })

  it('routes meetings → querySearchResults with (ids[], question, attachments)', async () => {
    const result = await chatDispatch({
      kind: { kind: 'meetings', meetingIds: ['a', 'b'] },
      question: 'q?',
    })
    expect(result).toBe('search-response')
    expect(mockQuerySearchResults).toHaveBeenCalledWith(['a', 'b'], 'q?', [])
  })

  it('routes company → queryCompany with (id, question, attachments)', async () => {
    const result = await chatDispatch({
      kind: { kind: 'company', companyId: 'c1' },
      question: 'q?',
    })
    expect(result).toBe('company-response')
    expect(mockQueryCompany).toHaveBeenCalledWith('c1', 'q?', undefined)
  })

  it('routes contact → queryContact with (id, question, attachments)', async () => {
    const result = await chatDispatch({
      kind: { kind: 'contact', contactId: 'p1' },
      question: 'q?',
    })
    expect(result).toBe('contact-response')
    expect(mockQueryContact).toHaveBeenCalledWith('p1', 'q?', undefined)
  })

  it('routes global → queryAll with (question, attachments)', async () => {
    const result = await chatDispatch({
      kind: { kind: 'global' },
      question: 'q?',
    })
    expect(result).toBe('global-response')
    expect(mockQueryAll).toHaveBeenCalledWith('q?', [])
  })

  it('defaults attachments to [] for kinds that take a positional array', async () => {
    await chatDispatch({ kind: { kind: 'meeting', meetingId: 'm1' }, question: 'q' })
    expect(mockQueryMeeting).toHaveBeenCalledWith('m1', 'q', [])

    await chatDispatch({ kind: { kind: 'global' }, question: 'q' })
    expect(mockQueryAll).toHaveBeenCalledWith('q', [])
  })
})

// ── Never-guard ────────────────────────────────────────────────────────

describe('chatDispatch — never-guard', () => {
  it('throws on an unknown kind (defense for `as any` callers)', async () => {
    const bogus = { kind: 'bogus' } as unknown as Parameters<typeof chatDispatch>[0]['kind']
    await expect(
      chatDispatch({ kind: bogus, question: 'q' })
    ).rejects.toThrow(/unknown ChatKind/i)
  })
})

// ── Abort ──────────────────────────────────────────────────────────────

describe('abortChatDispatch', () => {
  it('delegates to abortChatTurn (single shared controller)', () => {
    abortChatDispatch()
    expect(mockAbortChatTurn).toHaveBeenCalledTimes(1)
  })
})
