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
  it('routes meeting kind to CHAT_QUERY_MEETING + CHAT_ABORT (no attached refs)', () => {
    const d = chatChannels({ kind: 'meeting', meetingId: 'm1' })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_MEETING)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT)
    // 4th arg is the attached-entity wire list, empty when none attached.
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual(['m1', 'q', undefined, []])
  })

  it('serializes attached company/contact refs as the meeting kind 4th arg', () => {
    const d = chatChannels({
      kind: 'meeting',
      meetingId: 'm1',
      refs: [
        { type: 'company', id: 'c1', label: 'Acme' },
        { type: 'contact', id: 'p1', label: 'Jane' },
      ],
    })
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([
      'm1',
      'q',
      undefined,
      // labels dropped for the wire (resolved server-side)
      [
        { type: 'company', id: 'c1' },
        { type: 'contact', id: 'p1' },
      ],
    ])
  })

  it('routes meetings (search-results) to CHAT_QUERY_SEARCH_RESULTS + CHAT_ABORT_ALL', () => {
    const d = chatChannels({ kind: 'meetings', meetingIds: ['a', 'b'] })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT_ALL)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([['a', 'b'], 'q', undefined])
  })

  it('routes entities kind to CHAT_QUERY_ENTITIES + CHAT_ABORT_ALL, carrying refs + persistence anchor', () => {
    const d = chatChannels({
      kind: 'entities',
      refs: [
        { type: 'company', id: 'c1', label: 'Acme' },
        { type: 'contact', id: 'p1', label: 'Jane' },
      ],
      contextId: 'company:c1',
      contextKind: 'company',
      contextLabel: 'Acme',
    })
    expect(d.query).toBe(IPC_CHANNELS.CHAT_QUERY_ENTITIES)
    expect(d.abort).toBe(IPC_CHANNELS.CHAT_ABORT_ALL)
    expect(d.buildInvokeArgs({ question: 'q' })).toEqual([
      {
        // refs are reduced to {type,id} for the wire (label not needed server-side)
        refs: [
          { type: 'company', id: 'c1' },
          { type: 'contact', id: 'p1' },
        ],
        question: 'q',
        attachments: undefined,
        contextId: 'company:c1',
        contextKind: 'company',
        contextLabel: 'Acme',
      },
    ])
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
      [],
    ])
  })

  it('throws on an unknown kind via the never-guard', () => {
    const bogus = { kind: 'bogus' } as unknown as ChatKind
    expect(() => chatChannels(bogus)).toThrow(/unknown ChatKind/i)
  })
})
