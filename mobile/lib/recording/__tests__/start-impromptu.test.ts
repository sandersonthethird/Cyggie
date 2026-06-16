import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))

const mockPush = vi.fn()
vi.mock('expo-router', () => ({ router: { push: (p: string) => mockPush(p) } }))

let startShouldThrow: Error | null = null
const startCalls: Array<{ meetingId: string; title: string; discardOnCancel: boolean }> = []
vi.mock('../session', () => ({
  startRecording: async (ctx: { meetingId: string; title: string; discardOnCancel: boolean }) => {
    startCalls.push(ctx)
    if (startShouldThrow) throw startShouldThrow
  },
}))

let storeStatus = 'idle'
vi.mock('../store', () => ({
  useRecordingStore: { getState: () => ({ status: storeStatus }) },
}))

const confirmed: string[] = []
vi.mock('../confirmed-meetings', () => ({
  markMeetingConfirmed: (id: string) => confirmed.push(id),
}))

let createShouldReject: Error | null = null
const createCalls: Array<{ id: string; title: string }> = []
vi.mock('../../api/meetings', () => ({
  createImpromptuMeeting: async (input: { id: string; title: string }) => {
    createCalls.push(input)
    if (createShouldReject) throw createShouldReject
    return { ...buildStub(input.id), id: input.id }
  },
}))

function buildStub(id: string) {
  return { id, title: 'srv', status: 'recording' }
}

const { startImpromptuRecording } = await import('../start-impromptu')

// Fake QueryClient capturing cache writes/removes.
function fakeQC() {
  const sets: Array<{ key: unknown; data: unknown }> = []
  const removes: unknown[] = []
  return {
    setQueryData: (key: unknown, data: unknown) => sets.push({ key, data }),
    removeQueries: (arg: unknown) => removes.push(arg),
    _sets: sets,
    _removes: removes,
  }
}

beforeEach(() => {
  startShouldThrow = null
  createShouldReject = null
  storeStatus = 'idle'
  startCalls.length = 0
  createCalls.length = 0
  confirmed.length = 0
  mockPush.mockClear()
})

describe('startImpromptuRecording', () => {
  it('uses ONE id end-to-end: optimistic seed → startRecording → navigate → create', async () => {
    const qc = fakeQC()
    await startImpromptuRecording(qc as never)
    // wait a microtask for the fire-and-forget create().then to run
    await new Promise((r) => setTimeout(r, 0))

    const seededId = (qc._sets[0].data as { id: string }).id
    expect(qc._sets[0].key).toEqual(['meetings', 'detail', seededId])
    expect(startCalls[0].meetingId).toBe(seededId)
    expect(startCalls[0].discardOnCancel).toBe(true)
    expect(mockPush).toHaveBeenCalledWith(`/meetings/${seededId}`)
    expect(createCalls[0].id).toBe(seededId)
    expect(confirmed).toContain(seededId) // confirmed after create success
  })

  it('bails when a recording is already in flight (re-entry guard)', async () => {
    storeStatus = 'recording'
    const qc = fakeQC()
    await startImpromptuRecording(qc as never)
    expect(startCalls).toHaveLength(0)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('mic failure → drops optimistic record, does not navigate', async () => {
    startShouldThrow = new Error('permission denied')
    const qc = fakeQC()
    await startImpromptuRecording(qc as never)
    expect(qc._removes.length).toBe(1) // optimistic entry removed
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('offline (create rejects) → still records + navigates; stays unconfirmed', async () => {
    createShouldReject = new Error('Network request failed')
    const qc = fakeQC()
    await startImpromptuRecording(qc as never)
    await new Promise((r) => setTimeout(r, 0))
    const seededId = (qc._sets[0].data as { id: string }).id
    expect(mockPush).toHaveBeenCalledWith(`/meetings/${seededId}`)
    expect(confirmed).not.toContain(seededId) // not confirmed — upload will confirm later
  })
})
