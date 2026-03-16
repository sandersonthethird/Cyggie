// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRefresh = vi.fn().mockResolvedValue(undefined)
vi.mock('../renderer/stores/custom-fields.store', () => ({
  useCustomFieldStore: { getState: () => ({ refresh: mockRefresh }) }
}))
vi.mock('../renderer/api', () => ({
  api: { invoke: vi.fn() }
}))

import { api } from '../renderer/api'
import { addCustomFieldOption } from '../renderer/utils/customFieldUtils'

describe('addCustomFieldOption', () => {
  beforeEach(() => {
    vi.mocked(api.invoke).mockClear()
    vi.mocked(api.invoke).mockResolvedValue({ success: true })
    mockRefresh.mockClear()
  })

  it('adds a new option to empty optionsJson', async () => {
    await addCustomFieldOption('def1', null, 'B2B')
    expect(api.invoke).toHaveBeenCalledWith(
      expect.any(String), 'def1', { optionsJson: '["B2B"]' }
    )
    expect(mockRefresh).toHaveBeenCalledOnce()
  })

  it('appends to existing options', async () => {
    await addCustomFieldOption('def1', '["B2B"]', 'B2C')
    expect(api.invoke).toHaveBeenCalledWith(
      expect.any(String), 'def1', { optionsJson: '["B2B","B2C"]' }
    )
  })

  it('deduplicates silently — no IPC call', async () => {
    await addCustomFieldOption('def1', '["B2B"]', 'B2B')
    expect(api.invoke).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('ignores empty/whitespace-only input', async () => {
    await addCustomFieldOption('def1', '["B2B"]', '   ')
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('trims whitespace from option', async () => {
    await addCustomFieldOption('def1', null, '  B2B  ')
    expect(api.invoke).toHaveBeenCalledWith(
      expect.any(String), 'def1', { optionsJson: '["B2B"]' }
    )
  })

  it('truncates options > 200 chars', async () => {
    const long = 'x'.repeat(250)
    await addCustomFieldOption('def1', null, long)
    expect(api.invoke).toHaveBeenCalledWith(
      expect.any(String), 'def1', { optionsJson: JSON.stringify(['x'.repeat(200)]) }
    )
  })

  it('handles malformed optionsJson gracefully (treats as empty)', async () => {
    await addCustomFieldOption('def1', 'not-json', 'B2B')
    expect(api.invoke).toHaveBeenCalledWith(
      expect.any(String), 'def1', { optionsJson: '["B2B"]' }
    )
  })

  it('throws when IPC returns success: false', async () => {
    vi.mocked(api.invoke).mockResolvedValue({ success: false, message: 'DB error' })
    await expect(addCustomFieldOption('def1', null, 'B2B')).rejects.toThrow('DB error')
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('does not throw when refresh() fails (logs warning instead)', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('IPC error'))
    await expect(addCustomFieldOption('def1', null, 'B2B')).resolves.not.toThrow()
  })
})
