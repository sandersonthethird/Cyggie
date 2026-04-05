/**
 * Tests for google-auth account email getters.
 *
 * Coverage diagram:
 *
 *   getCalendarAccountEmail()
 *     ├── nothing stored  → null
 *     ├── email stored    → returns email string
 *     └── empty string stored → null (|| null coercion)
 *
 *   getGmailAccountEmail()
 *     ├── nothing stored  → null
 *     └── email stored    → returns email string
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock credentials module before importing google-auth
vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(),
  storeCredential: vi.fn()
}))

// Mock googleapis to prevent real HTTP/OAuth calls
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        generateAuthUrl: vi.fn(() => 'https://mock-auth-url'),
      }))
    },
    oauth2: vi.fn(),
  }
}))

// Mock electron
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() }
}))

import { getCredential } from '../main/security/credentials'
import { getCalendarAccountEmail, getGmailAccountEmail } from '../main/calendar/google-auth'

const mockGetCredential = vi.mocked(getCredential)

describe('getCalendarAccountEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when nothing is stored', () => {
    mockGetCredential.mockReturnValue(null)
    expect(getCalendarAccountEmail()).toBeNull()
  })

  it('returns the stored email string', () => {
    mockGetCredential.mockReturnValue('user@example.com')
    expect(getCalendarAccountEmail()).toBe('user@example.com')
  })

  it('returns null when stored value is empty string', () => {
    mockGetCredential.mockReturnValue('')
    expect(getCalendarAccountEmail()).toBeNull()
  })
})

describe('getGmailAccountEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when nothing is stored', () => {
    mockGetCredential.mockReturnValue(null)
    expect(getGmailAccountEmail()).toBeNull()
  })

  it('returns the stored email string', () => {
    mockGetCredential.mockReturnValue('gmail@example.com')
    expect(getGmailAccountEmail()).toBe('gmail@example.com')
  })
})
