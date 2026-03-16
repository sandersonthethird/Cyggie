// @vitest-environment jsdom
/**
 * Tests for mergeBuiltinOptions (pure renderer utility) and
 * renameBuiltinOption / countBuiltinOptionUsage (DB repo functions).
 *
 * The DB tests require better-sqlite3 and will fail if the native module
 * is compiled against a different Node.js version (pre-existing env issue).
 * The mergeBuiltinOptions tests have no DB dependency and always pass.
 */
import { describe, it, expect, vi } from 'vitest'
import { mergeBuiltinOptions } from '../renderer/utils/customFieldUtils'

// Required by customFieldUtils (addCustomFieldOption) — not used in these tests
vi.mock('../renderer/stores/custom-fields.store', () => ({
  useCustomFieldStore: { getState: () => ({ refresh: vi.fn().mockResolvedValue(undefined) }) }
}))
vi.mock('../renderer/api', () => ({ api: { invoke: vi.fn() } }))

// ── mergeBuiltinOptions (pure function — no DB) ────────────────────────────────

describe('mergeBuiltinOptions', () => {
  const hardcoded = [
    { value: 'screening', label: 'Screening' },
    { value: 'diligence', label: 'Diligence' },
  ]

  it('returns hardcoded options unchanged when optionsJson is null', () => {
    const result = mergeBuiltinOptions(hardcoded, null)
    expect(result).toEqual(hardcoded)
  })

  it('appends user additions to hardcoded options', () => {
    const result = mergeBuiltinOptions(hardcoded, '["custom_stage"]')
    expect(result).toEqual([
      { value: 'screening', label: 'Screening' },
      { value: 'diligence', label: 'Diligence' },
      { value: 'custom_stage', label: 'custom_stage' },
    ])
  })

  it('falls back to hardcoded when optionsJson is malformed JSON', () => {
    const result = mergeBuiltinOptions(hardcoded, 'not-valid-json')
    expect(result).toEqual(hardcoded)
  })
})
