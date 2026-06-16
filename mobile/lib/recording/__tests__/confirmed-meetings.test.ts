import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory MMKV double.
const store = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    set: (k: string, v: string) => void store.set(k, v),
    getString: (k: string) => store.get(k),
    delete: (k: string) => void store.delete(k),
    getAllKeys: () => Array.from(store.keys()),
  },
}))

const { isMeetingConfirmed, markMeetingConfirmed, clearMeetingConfirmed, onMeetingConfirmed } =
  await import('../confirmed-meetings')

beforeEach(() => store.clear())

describe('confirmed-meetings', () => {
  it('marks + reads confirmation, persisted across reads', () => {
    expect(isMeetingConfirmed('m1')).toBe(false)
    markMeetingConfirmed('m1')
    expect(isMeetingConfirmed('m1')).toBe(true)
    // Independent ids stay independent.
    expect(isMeetingConfirmed('m2')).toBe(false)
  })

  it('notifies subscribers on the first confirmation only', () => {
    const seen: string[] = []
    const unsub = onMeetingConfirmed((id) => seen.push(id))
    markMeetingConfirmed('m1')
    markMeetingConfirmed('m1') // idempotent — no second notify
    markMeetingConfirmed('m2')
    unsub()
    markMeetingConfirmed('m3') // after unsub — not seen
    expect(seen).toEqual(['m1', 'm2'])
  })

  it('clears a confirmation (cancelled meeting)', () => {
    markMeetingConfirmed('m1')
    clearMeetingConfirmed('m1')
    expect(isMeetingConfirmed('m1')).toBe(false)
  })

  it('survives a corrupt blob by resetting', () => {
    store.set('cyggie.confirmed-meetings.v1', '{not json')
    expect(isMeetingConfirmed('m1')).toBe(false)
    markMeetingConfirmed('m1')
    expect(isMeetingConfirmed('m1')).toBe(true)
  })
})
