/**
 * Verifies the kind → IPC channel lookup that drives every chat turn dispatch.
 *
 *   ChatKind  ──▶ chatChannels()  ──▶ { query, abort, buildInvokeArgs }
 *
 * A miss in this table is the difference between "abort the right turn" and
 * "abort an unrelated handler", so the table is exhaustive-tested and the
 * never-guard is verified.
 */
import { describe, it, expect } from 'vitest'
import { chatChannels, type ChatKind } from '../renderer/lib/chat-channels'
import { IPC_CHANNELS } from '../shared/constants/channels'

describe('chatChannels', () => {
  it('routes meeting kind to CHAT_QUERY_MEETING + CHAT_ABORT', () => {
    const d = chatChannels({ kind: 'meeting', meetingId: 'm1' })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_MEETING)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual(['m1', 'q', undefined])
  })

  it('routes meetings (search-results) to CHAT_QUERY_SEARCH_RESULTS + CHAT_ABORT_ALL', () => {
    const d = chatChannels({ kind: 'meetings', meetingIds: ['a', 'b'] })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT_ALL)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([['a', 'b'], 'q', undefined])
  })

  it('routes company kind to COMPANY_CHAT_QUERY + COMPANY_CHAT_ABORT', () => {
    const d = chatChannels({ kind: 'company', companyId: 'c1' })
    expect(d.query).toBe(IPC_CHANNELS.COMPANY_CHAT_QUERY)
    expect(d.abort).toBe(IPC_CHANNELS.COMPANY_CHAT_ABORT)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([{ companyId: 'c1', question: 'q', attachments: undefined }])
  })

  it('routes contact kind to CONTACT_CHAT_QUERY + CONTACT_CHAT_ABORT', () => {
    const d = chatChannels({ kind: 'contact', contactId: 'p1' })
    expect(d.query).toBe(IPC_CHANNELS.CONTACT_CHAT_QUERY)
    expect(d.abort).toBe(IPC_CHANNELS.CONTACT_CHAT_ABORT)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([{ contactId: 'p1', question: 'q', attachments: undefined }])
  })

  it('routes global kind to CHAT_QUERY_ALL + CHAT_ABORT_ALL', () => {
    const d = chatChannels({ kind: 'global' })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_ALL)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT_ALL)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([{ question: 'q', attachments: undefined }])
  })

  it('forwards attachments verbatim to buildInvokeArgs', () => {
    const att = [{ name: 'a.txt', mimeType: 'text/plain', type: 'text' as const, data: 'hi' }]
    expect(chatChannels({ kind: 'global' }).buildInvokeArgs({ question: 'q', attachments: att })).toEqual([
      { question: 'q', attachments: att },
    ])
    expect(chatChannels({ kind: 'meeting', meetingId: 'm1' }).buildInvokeArgs({ question: 'q', attachments: att })).toEqual([
      'm1',
      'q',
      att,
    ])
  })

  it('throws on an unknown kind via the never-guard', () => {
    const bogus = { kind: 'bogus' } as unknown as ChatKind
    expect(() => chatChannels(bogus)).toThrow(/unknown ChatKind/i)
  })
})
