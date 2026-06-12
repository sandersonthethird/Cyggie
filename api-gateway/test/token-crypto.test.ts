// Unit tests for the AES-256-GCM refresh-token encryption (auth/token-crypto.ts).
// No DB / no env loading — we pass keys explicitly.

import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { encryptToken, decryptToken, TokenCryptoError } from '../src/auth/token-crypto'

const KEY = randomBytes(32).toString('base64') // valid 32-byte key

describe('token-crypto', () => {
  test('round-trips a token', () => {
    const plain = '1//refresh-token-' + randomBytes(16).toString('hex')
    const blob = encryptToken(plain, KEY)
    expect(blob).toMatch(/^[^:]+:[^:]+:[^:]+$/) // iv:tag:ct
    expect(blob).not.toContain(plain)
    expect(decryptToken(blob, KEY)).toBe(plain)
  })

  test('produces a fresh IV each call (ciphertext differs for same input)', () => {
    const a = encryptToken('same', KEY)
    const b = encryptToken('same', KEY)
    expect(a).not.toBe(b)
    expect(decryptToken(a, KEY)).toBe('same')
    expect(decryptToken(b, KEY)).toBe('same')
  })

  test('legacy SHA-256 hash input throws (not silently mis-decrypted)', () => {
    // What old rows actually hold: a 64-char hex digest, no colons.
    const legacy = createHash('sha256').update('old-refresh-token').digest('hex')
    expect(() => decryptToken(legacy, KEY)).toThrow(TokenCryptoError)
  })

  test('tampered ciphertext fails GCM auth and throws', () => {
    const blob = encryptToken('secret', KEY)
    const [iv, tag, ct] = blob.split(':')
    // Flip a byte in the ciphertext.
    const tamperedCt = Buffer.from(ct, 'base64url')
    tamperedCt[0] ^= 0xff
    const tampered = [iv, tag, tamperedCt.toString('base64url')].join(':')
    expect(() => decryptToken(tampered, KEY)).toThrow(TokenCryptoError)
  })

  test('wrong key throws (cannot decrypt another key’s blob)', () => {
    const blob = encryptToken('secret', KEY)
    const otherKey = randomBytes(32).toString('base64')
    expect(() => decryptToken(blob, otherKey)).toThrow(TokenCryptoError)
  })

  test('rejects a key that is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => encryptToken('x', shortKey)).toThrow(TokenCryptoError)
  })
})
