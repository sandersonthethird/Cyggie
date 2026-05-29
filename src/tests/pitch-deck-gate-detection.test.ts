/**
 * Tests for looksLikeGatedPlatformContent — the layer-2 heuristic that catches
 * URL ingests where the page returned the gating platform's wrapper UI rather
 * than the actual document content. Without this, the LLM fabricates a
 * "Partner Sync Summary" of the platform itself (e.g. "DocSend is a document
 * sharing platform").
 *
 * The helper combines a hostname allowlist with text-marker matching — both
 * must trip to avoid false positives on, e.g., a legitimate company website
 * that happens to use the phrase "sign in to view".
 */

import { describe, it, expect } from 'vitest'
import { looksLikeGatedPlatformContent } from '../main/services/pitch-deck-ingestion.service'

describe('looksLikeGatedPlatformContent', () => {
  it('flags DocSend gate pages', () => {
    const text = 'DocSend\nPlease enter your email to view this document.\nNicole'
    expect(looksLikeGatedPlatformContent('docsend.com', text)).toBe(true)
  })

  it('flags subdomains of gating platforms', () => {
    const text = 'Please enter your email address to continue'
    expect(looksLikeGatedPlatformContent('app.docsend.com', text)).toBe(true)
  })

  it('flags Google Drive view-only access prompts', () => {
    const text = 'You need access\nRequest access or switch accounts.'
    expect(looksLikeGatedPlatformContent('drive.google.com', text)).toBe(true)
  })

  it('matches markers case-insensitively', () => {
    const text = 'PLEASE ENTER YOUR EMAIL'
    expect(looksLikeGatedPlatformContent('docsend.com', text)).toBe(true)
  })

  it('does not flag a non-gating host even if marker phrase appears', () => {
    const text = 'Please enter your email to subscribe to our newsletter'
    expect(looksLikeGatedPlatformContent('acme.com', text)).toBe(false)
  })

  it('does not flag a gating host when no marker is present (deck fully loaded)', () => {
    const text = 'Acme raises $10M Series A to revolutionize cloud storage. Our team includes ...'
    expect(looksLikeGatedPlatformContent('docsend.com', text)).toBe(false)
  })

  it('does not false-match on hostnames that merely contain a gated suffix', () => {
    // notdocsend.com should NOT match docsend.com
    const text = 'Please enter your email'
    expect(looksLikeGatedPlatformContent('notdocsend.com', text)).toBe(false)
  })
})
