// @vitest-environment jsdom

// Slice B (9A) — guard logic for the firm-template seed. The hook must:
//   • skip entirely when there's no firm (pre-onboarding)
//   • skip the /firms/me fetch when the firm-id marker is already set (11A)
//   • skip seeding (and NOT set the marker) when the fetch can't be read (403/offline)
//   • seed with the fetched template_id and set the marker on success
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

// Shared mutable state lives in vi.hoisted so the hoisted vi.mock factories can
// reference it (top-level consts would not yet be initialized at hoist time).
const h = vi.hoisted(() => ({
  authStatus: { firmId: null as string | null },
  fetchResult: { ok: false } as { ok: true; templateId: string | null } | { ok: false },
  marker: null as string | null,
  invoke: vi.fn(),
  setJSON: vi.fn(),
  getJSON: vi.fn(),
  prefsLoad: vi.fn(),
  cfLoad: vi.fn(),
  applyFirmTemplate: vi.fn(),
}))

vi.mock('../../api', () => ({ api: { invoke: h.invoke } }))
vi.mock('../../stores/preferences.store', () => ({
  usePreferencesStore: {
    getState: () => ({ load: h.prefsLoad, getJSON: h.getJSON, setJSON: h.setJSON }),
  },
}))
vi.mock('../../stores/custom-fields.store', () => ({
  useCustomFieldStore: { getState: () => ({ load: h.cfLoad, companyDefs: [] }) },
}))
vi.mock('../../lib/applyFirmTemplate', () => ({ applyFirmTemplate: h.applyFirmTemplate }))
vi.mock('../../components/crm/ViewsBar', () => ({ ensureView: vi.fn() }))
vi.mock('../../utils/customFieldUtils', () => ({ addCustomFieldOption: vi.fn() }))

import { useFirmTemplate } from '../useFirmTemplate'

beforeEach(() => {
  vi.clearAllMocks()
  h.authStatus = { firmId: null }
  h.fetchResult = { ok: false }
  h.marker = null
  h.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.CYGGIE_AUTH_STATUS) return h.authStatus
    if (channel === IPC_CHANNELS.FIRM_TEMPLATE_FETCH) return h.fetchResult
    return undefined
  })
  h.getJSON.mockImplementation((_key: string, _default: unknown) => h.marker)
  h.setJSON.mockImplementation((_key: string, value: string) => {
    h.marker = value
  })
  h.prefsLoad.mockResolvedValue(undefined)
  h.cfLoad.mockResolvedValue(undefined)
  h.applyFirmTemplate.mockResolvedValue(undefined)
})

// Aliases so the assertions below read cleanly.
const invoke = h.invoke
const setJSON = h.setJSON
const prefsLoad = h.prefsLoad
const applyFirmTemplate = h.applyFirmTemplate

describe('useFirmTemplate guard', () => {
  test('no firm → skips entirely (no fetch, no seed)', async () => {
    h.authStatus = { firmId: null }
    renderHook(() => useFirmTemplate())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CYGGIE_AUTH_STATUS))
    expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.FIRM_TEMPLATE_FETCH)
    expect(applyFirmTemplate).not.toHaveBeenCalled()
  })

  test('marker already set → skips the /firms/me fetch (11A)', async () => {
    h.authStatus = { firmId: 'firm-1' }
    h.marker = '2026-06-28T00:00:00Z'
    renderHook(() => useFirmTemplate())
    await waitFor(() => expect(prefsLoad).toHaveBeenCalled())
    expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.FIRM_TEMPLATE_FETCH)
    expect(applyFirmTemplate).not.toHaveBeenCalled()
  })

  test('fetch not ok (403/offline) → no seed, marker not set', async () => {
    h.authStatus = { firmId: 'firm-1' }
    h.fetchResult = { ok: false }
    renderHook(() => useFirmTemplate())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.FIRM_TEMPLATE_FETCH))
    expect(applyFirmTemplate).not.toHaveBeenCalled()
    expect(setJSON).not.toHaveBeenCalled()
  })

  test('fetch ok → seeds with template id and sets marker after success', async () => {
    h.authStatus = { firmId: 'firm-1' }
    h.fetchResult = { ok: true, templateId: 'sales' }
    renderHook(() => useFirmTemplate())
    await waitFor(() => expect(applyFirmTemplate).toHaveBeenCalled())
    expect(applyFirmTemplate).toHaveBeenCalledWith('sales', expect.anything())
    expect(setJSON).toHaveBeenCalledWith(
      'cyggie:firm-template-seeded:firm-1',
      expect.any(String),
    )
  })
})
