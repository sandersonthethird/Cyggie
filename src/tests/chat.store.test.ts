import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../renderer/stores/chat.store'

beforeEach(() => {
  useChatStore.setState({ conversations: {}, pageContext: null })
})

describe('pageContext', () => {
  it('stores context on setPageContext', () => {
    useChatStore.getState().setPageContext({ meetingId: 'meet1' })
    expect(useChatStore.getState().pageContext).toEqual({ meetingId: 'meet1' })
  })

  it('clears context on setPageContext(null)', () => {
    useChatStore.getState().setPageContext({ meetingId: 'meet1' })
    useChatStore.getState().setPageContext(null)
    expect(useChatStore.getState().pageContext).toBeNull()
  })

  it('pageContext changes do not affect conversations', () => {
    useChatStore.getState().addMessage('global-all', { role: 'user', content: 'hi' })
    useChatStore.getState().setPageContext({ meetingId: 'meet1' })
    expect(useChatStore.getState().conversations['global-all']?.messages).toHaveLength(1)
  })

  it('stores contextOptions for company context', () => {
    useChatStore.getState().setPageContext({
      contextOptions: [{ type: 'company', id: 'co1', name: 'Acme Corp' }]
    })
    const ctx = useChatStore.getState().pageContext
    expect(ctx?.contextOptions?.[0]).toEqual({ type: 'company', id: 'co1', name: 'Acme Corp' })
  })

  it('stores contextOptions for contact context', () => {
    useChatStore.getState().setPageContext({
      contextOptions: [{ type: 'contact', id: 'c1', name: 'Jane Doe' }]
    })
    const ctx = useChatStore.getState().pageContext
    expect(ctx?.contextOptions?.[0]).toEqual({ type: 'contact', id: 'c1', name: 'Jane Doe' })
  })

  it('stores meetingId with contextOptions for meeting detail page', () => {
    useChatStore.getState().setPageContext({
      meetingId: 'meet1',
      contextOptions: [{ type: 'company', id: 'co1', name: 'Acme Corp' }]
    })
    const ctx = useChatStore.getState().pageContext
    expect(ctx?.meetingId).toBe('meet1')
    expect(ctx?.contextOptions).toHaveLength(1)
  })

  it('stores meetingIds for search results', () => {
    useChatStore.getState().setPageContext({ meetingIds: ['m1', 'm2', 'm3'] })
    expect(useChatStore.getState().pageContext?.meetingIds).toEqual(['m1', 'm2', 'm3'])
  })

  it('replaces previous context on subsequent setPageContext calls', () => {
    useChatStore.getState().setPageContext({ meetingId: 'meet1' })
    useChatStore.getState().setPageContext({ contextOptions: [{ type: 'company', id: 'co1', name: 'Acme' }] })
    const ctx = useChatStore.getState().pageContext
    expect(ctx?.meetingId).toBeUndefined()
    expect(ctx?.contextOptions?.[0].id).toBe('co1')
  })
})

describe('conversations', () => {
  it('adds messages to a conversation', () => {
    useChatStore.getState().addMessage('global-all', { role: 'user', content: 'hello' })
    useChatStore.getState().addMessage('global-all', { role: 'assistant', content: 'hi there' })
    expect(useChatStore.getState().conversations['global-all']?.messages).toHaveLength(2)
  })

  it('keeps conversations for different contextIds separate', () => {
    useChatStore.getState().addMessage('global-all', { role: 'user', content: 'global' })
    useChatStore.getState().addMessage('company:co1', { role: 'user', content: 'company' })
    expect(useChatStore.getState().conversations['global-all']?.messages).toHaveLength(1)
    expect(useChatStore.getState().conversations['company:co1']?.messages).toHaveLength(1)
  })

  it('clears a specific conversation without affecting others', () => {
    useChatStore.getState().addMessage('global-all', { role: 'user', content: 'keep me' })
    useChatStore.getState().addMessage('company:co1', { role: 'user', content: 'clear me' })
    useChatStore.getState().clearConversation('company:co1')
    expect(useChatStore.getState().conversations['global-all']?.messages).toHaveLength(1)
    expect(useChatStore.getState().conversations['company:co1']).toBeUndefined()
  })
})
