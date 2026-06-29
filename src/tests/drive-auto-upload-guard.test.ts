/**
 * shouldAutoUploadToDrive — the finalize-time gate for the legacy Drive-API
 * auto-upload. A wrong/inverted guard is a SILENT privacy leak (a private file
 * uploaded to the Drive API), so the full matrix is pinned here.
 *
 * Upload only when: Drive connected AND two-tier OFF AND meeting EXPLICITLY public.
 * Fail-closed: null / unknown privacy ⇒ no upload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Controllable deps. google-drive.ts imports four symbols from google-auth and
// markdown helpers from memo-export.service — stub them so importing the module
// under test doesn't drag in googleapis/OAuth/runtime.
const scope = { v: true }
const flag = { v: false }

vi.mock('../main/calendar/google-auth', () => ({
  hasDriveScope: () => scope.v,
  getDriveFilesOAuth2Client: vi.fn(),
  getOAuth2Client: vi.fn(),
  isCalendarConnected: vi.fn(),
}))
vi.mock('../main/storage/routing', () => ({
  isTwoTierStorageEnabled: () => flag.v,
}))
vi.mock('../main/services/memo-export.service', () => ({
  markdownToHtml: vi.fn(),
  buildMemoDocTitle: vi.fn(),
}))

const { shouldAutoUploadToDrive } = await import('../main/drive/google-drive')

beforeEach(() => {
  scope.v = true
  flag.v = false
})

describe('shouldAutoUploadToDrive', () => {
  it('uploads a public meeting when Drive is connected and two-tier is off', () => {
    expect(shouldAutoUploadToDrive({ isPrivate: false })).toBe(true)
  })

  it('skips when Drive is not connected', () => {
    scope.v = false
    expect(shouldAutoUploadToDrive({ isPrivate: false })).toBe(false)
  })

  it('skips when two-tier is on (the Drive mount already holds public files)', () => {
    flag.v = true
    expect(shouldAutoUploadToDrive({ isPrivate: false })).toBe(false)
  })

  it('skips a private meeting', () => {
    expect(shouldAutoUploadToDrive({ isPrivate: true })).toBe(false)
  })

  it('fail-closed: skips when privacy is unknown (null / undefined / missing / no meeting)', () => {
    expect(shouldAutoUploadToDrive({ isPrivate: null })).toBe(false)
    expect(shouldAutoUploadToDrive({ isPrivate: undefined })).toBe(false)
    expect(shouldAutoUploadToDrive({})).toBe(false)
    expect(shouldAutoUploadToDrive(null)).toBe(false)
    expect(shouldAutoUploadToDrive(undefined)).toBe(false)
  })
})
