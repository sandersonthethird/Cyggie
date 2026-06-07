import { describe, expect, test } from 'vitest'
import {
  decideFocus,
  questionMentionsName,
  hasOtherProperNoun,
  FOCUS_TTL_MS,
  type ThreadFocus,
} from '../src/slack/thread-focus'

// Pure-function coverage for the Slack thread-focus heuristic (Part 2). No DB,
// no LLM — the brittle decision logic is fully exercised here; the live
// cache-hit is verified manually per the plan (6A).

const NOW = 1_800_000_000_000 // fixed clock — decideFocus takes nowMs injected

function focus(entityType: 'company' | 'contact', entityId: string, ageMs = 0): ThreadFocus {
  return { entityType, entityId, updatedAt: new Date(NOW - ageMs) }
}

describe('questionMentionsName', () => {
  test('plain mention', () => {
    expect(questionMentionsName('How is Acme doing?', 'Acme')).toBe(true)
  })
  test('possessive mention', () => {
    expect(questionMentionsName("What's Acme's runway?", 'Acme Inc')).toBe(false) // "acme inc" not a substring
    expect(questionMentionsName("What's Acme's runway?", 'Acme')).toBe(true)
  })
  test('case + accent insensitive', () => {
    expect(questionMentionsName('news on münchen labs', 'München Labs')).toBe(true)
  })
  test('no mention', () => {
    expect(questionMentionsName('How is Beta doing?', 'Acme')).toBe(false)
  })
})

describe('hasOtherProperNoun', () => {
  test('different company name → true', () => {
    expect(hasOtherProperNoun('How is Beta doing?', 'Acme')).toBe(true)
  })
  test('only the focus name (and stopwords) → false', () => {
    expect(hasOtherProperNoun("What's Acme's burn rate?", 'Acme')).toBe(false)
  })
  test('pure anaphor, no proper noun → false', () => {
    expect(hasOtherProperNoun('what was their valuation?', 'Acme')).toBe(false)
  })
  test('sentence-opener capitals are not proper nouns', () => {
    expect(hasOtherProperNoun('How are they doing on hiring?', 'Acme')).toBe(false)
  })
  test('null focus name → any proper noun counts', () => {
    expect(hasOtherProperNoun('How is Beta doing?', null)).toBe(true)
    expect(hasOtherProperNoun('what was their valuation?', null)).toBe(false)
  })
})

describe('decideFocus — cold / TTL', () => {
  test('no stored focus → cold', () => {
    expect(decideFocus({ question: 'x', currentFocus: null, focusName: null, nowMs: NOW }))
      .toEqual({ action: 'cold', injectFocus: null })
  })
  test('focus older than TTL → cold even on an exact name mention', () => {
    const f = focus('company', 'co_1', FOCUS_TTL_MS + 1)
    expect(decideFocus({ question: 'How is Acme doing?', currentFocus: f, focusName: 'Acme', nowMs: NOW }).action)
      .toBe('cold')
  })
  test('exactly at TTL boundary is still warm', () => {
    const f = focus('company', 'co_1', FOCUS_TTL_MS)
    expect(decideFocus({ question: 'How is Acme doing?', currentFocus: f, focusName: 'Acme', nowMs: NOW }).action)
      .toBe('reuse')
  })
})

describe('decideFocus — reuse', () => {
  test('question mentions the focus entity → reuse + injectFocus', () => {
    const f = focus('company', 'co_1')
    const d = decideFocus({ question: "What's Acme's latest round?", currentFocus: f, focusName: 'Acme', nowMs: NOW })
    expect(d.action).toBe('reuse')
    expect(d.injectFocus).toEqual(f)
  })
  test('pure anaphor (no proper noun) → reuse', () => {
    const f = focus('contact', 'ct_9')
    const d = decideFocus({ question: 'what was their valuation?', currentFocus: f, focusName: 'Priya Rao', nowMs: NOW })
    expect(d.action).toBe('reuse')
  })
  test('generic follow-up with no entity → reuse', () => {
    const f = focus('company', 'co_1')
    expect(decideFocus({ question: 'and the burn rate?', currentFocus: f, focusName: 'Acme', nowMs: NOW }).action)
      .toBe('reuse')
  })
})

describe('decideFocus — skip (different entity named)', () => {
  test('question names a DIFFERENT company → skip (no stale context)', () => {
    const f = focus('company', 'co_1')
    const d = decideFocus({ question: 'How is Beta doing?', currentFocus: f, focusName: 'Acme', nowMs: NOW })
    expect(d).toEqual({ action: 'skip', injectFocus: null })
  })
  test('focus name unknown + a proper noun present → skip (conservative)', () => {
    const f = focus('company', 'co_1')
    const d = decideFocus({ question: 'How is Beta doing?', currentFocus: f, focusName: null, nowMs: NOW })
    expect(d.action).toBe('skip')
  })
  test('focus name unknown + pure anaphor → still reuse', () => {
    const f = focus('company', 'co_1')
    expect(decideFocus({ question: 'what about their runway?', currentFocus: f, focusName: null, nowMs: NOW }).action)
      .toBe('reuse')
  })
})
