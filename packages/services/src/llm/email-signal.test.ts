import { describe, expect, it } from 'vitest'
import {
  isLowSignalEmail,
  scoreEmailSignal,
  truncateEmailBody,
  stripQuotedHistory,
  resolveEmailCap,
  emailCapsForLimit,
  renderEmailRows,
  COMPANY_EMAIL_CAPS,
  MIN_EMAIL_BODY_CHARS,
  type EmailSignalInput,
  type EmailRowForThread,
} from './email-signal'

const longBody = 'x'.repeat(MIN_EMAIL_BODY_CHARS + 200)

const realThread: EmailSignalInput = {
  bodyText: longBody,
  subject: 'Re: term sheet questions',
  threadMessageCount: 4,
  labelsJson: '["INBOX"]',
  hasAttachments: false,
  linkConfidence: 0.95,
  linkedBy: 'manual',
  isTwoWay: true,
}

describe('isLowSignalEmail', () => {
  it('drops near-empty bodies', () => {
    expect(isLowSignalEmail({ bodyText: 'thanks!', subject: 'hi', threadMessageCount: 3, isTwoWay: true }))
      .toBe(true)
  })

  it('drops missing bodies', () => {
    expect(isLowSignalEmail({ bodyText: null, subject: 'hi' })).toBe(true)
  })

  it('drops calendar invites by subject prefix', () => {
    expect(
      isLowSignalEmail({
        bodyText: longBody,
        subject: 'Invitation: Pitch meeting @ Thu Jun 5',
        threadMessageCount: 1,
      }),
    ).toBe(true)
    expect(
      isLowSignalEmail({ bodyText: longBody, subject: 'Accepted: Coffee', threadMessageCount: 2, isTwoWay: true }),
    ).toBe(true)
  })

  it('drops promo / update / forum label blasts', () => {
    expect(
      isLowSignalEmail({
        bodyText: longBody,
        subject: 'Our latest newsletter',
        threadMessageCount: 1,
        labelsJson: '["INBOX","CATEGORY_PROMOTIONS"]',
      }),
    ).toBe(true)
  })

  it('drops one-way single-message threads (cold intro with no reply)', () => {
    expect(
      isLowSignalEmail({ bodyText: longBody, subject: 'Intro', threadMessageCount: 1, isTwoWay: false }),
    ).toBe(true)
  })

  it('keeps a real two-way thread', () => {
    expect(isLowSignalEmail(realThread)).toBe(false)
  })

  it('keeps a manually-tagged single one-way email (user intent overrides one-way drop)', () => {
    expect(
      isLowSignalEmail({
        bodyText: longBody,
        subject: 'Cold intro',
        threadMessageCount: 1,
        isTwoWay: false,
        linkedBy: 'manual',
      }),
    ).toBe(false)
  })

  it('keeps a substantive single message that is part of a two-way thread', () => {
    expect(
      isLowSignalEmail({ bodyText: longBody, subject: 'Reply', threadMessageCount: 1, isTwoWay: true }),
    ).toBe(false)
  })
})

describe('scoreEmailSignal', () => {
  it('ranks a real two-way thread above a one-off auto-linked email', () => {
    const oneOff: EmailSignalInput = {
      bodyText: longBody,
      subject: 'FYI',
      threadMessageCount: 1,
      linkConfidence: 0.8,
      linkedBy: 'auto',
      isTwoWay: false,
    }
    expect(scoreEmailSignal(realThread)).toBeGreaterThan(scoreEmailSignal(oneOff))
  })

  it('rewards manual links over auto links', () => {
    const base: EmailSignalInput = { bodyText: longBody, threadMessageCount: 2, isTwoWay: true }
    const manual = { ...base, linkedBy: 'manual' }
    const auto = { ...base, linkedBy: 'auto' }
    expect(scoreEmailSignal(manual)).toBeGreaterThan(scoreEmailSignal(auto))
  })

  it('rewards longer threads', () => {
    const short: EmailSignalInput = { bodyText: longBody, threadMessageCount: 2, isTwoWay: true }
    const long: EmailSignalInput = { bodyText: longBody, threadMessageCount: 6, isTwoWay: true }
    expect(scoreEmailSignal(long)).toBeGreaterThan(scoreEmailSignal(short))
  })

  it('is finite and non-negative for empty input', () => {
    const s = scoreEmailSignal({})
    expect(Number.isFinite(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
  })
})

describe('truncateEmailBody', () => {
  it('returns text unchanged when under cap', () => {
    expect(truncateEmailBody('hello', 100)).toBe('hello')
  })

  it('keeps BOTH ends (newest reply + original ask) when over cap', () => {
    const head = 'NEWEST_REPLY ' + 'a'.repeat(400)
    const tail = 'b'.repeat(400) + ' ORIGINAL_ASK'
    const text = head + tail
    const out = truncateEmailBody(text, 600)
    expect(out.length).toBeLessThanOrEqual(600)
    expect(out).toContain('NEWEST_REPLY')
    expect(out).toContain('ORIGINAL_ASK')
    expect(out).toContain('truncated')
  })

  it('clamps for tiny max — no negative slice, length ≤ max', () => {
    const out = truncateEmailBody('x'.repeat(500), 10)
    expect(out.length).toBeLessThanOrEqual(10)
  })

  it('handles max=0', () => {
    expect(truncateEmailBody('abc', 0)).toBe('')
  })
})

describe('stripQuotedHistory', () => {
  it('cuts at Gmail "On … wrote:" attribution', () => {
    const body = 'My new reply here.\n\nOn Mon, Jun 1, 2026 at 10:00 AM Foo <foo@bar.com> wrote:\n> old stuff'
    expect(stripQuotedHistory(body)).toBe('My new reply here.')
  })

  it('cuts at a > quoted block', () => {
    expect(stripQuotedHistory('Fresh text.\n> quoted line 1\n> quoted line 2')).toBe('Fresh text.')
  })

  it('cuts at Outlook -----Original Message-----', () => {
    expect(stripQuotedHistory('Reply.\n-----Original Message-----\nFrom: x')).toBe('Reply.')
  })

  it('cuts at Outlook From:/Sent: header block', () => {
    expect(stripQuotedHistory('Reply.\nFrom: A\nSent: yesterday\nTo: B')).toBe('Reply.')
  })

  it('returns whole body when no delimiter (top-post / single message)', () => {
    expect(stripQuotedHistory('Just a plain message with no quotes.')).toBe(
      'Just a plain message with no quotes.',
    )
  })

  it('does NOT cut on a lone "> " line (legit blockquote / metric)', () => {
    const body = 'We grew fast last quarter:\n> 50% MoM growth\nand churn stayed flat.'
    expect(stripQuotedHistory(body)).toBe(body.trim())
  })

  it('returns whole body when entirely quoted (forward, no comment)', () => {
    const body = '> entirely quoted forward content here'
    expect(stripQuotedHistory(body)).toBe(body.trim())
  })

  it('handles null/empty', () => {
    expect(stripQuotedHistory(null)).toBe('')
    expect(stripQuotedHistory('')).toBe('')
  })
})

describe('resolveEmailCap', () => {
  it('falls back to default for null/garbage', () => {
    expect(resolveEmailCap(null)).toBe(COMPANY_EMAIL_CAPS.maxItems)
    expect(resolveEmailCap('not-a-number')).toBe(COMPANY_EMAIL_CAPS.maxItems)
    expect(resolveEmailCap(undefined, 7)).toBe(7)
  })

  it('parses and clamps to [1, 100]', () => {
    expect(resolveEmailCap('30')).toBe(30)
    expect(resolveEmailCap('0')).toBe(1)
    expect(resolveEmailCap('9999')).toBe(100)
    expect(resolveEmailCap(50)).toBe(50)
  })
})

describe('emailCapsForLimit', () => {
  it('sets maxItems to the limit and scales total so it never binds first', () => {
    const caps = emailCapsForLimit(COMPANY_EMAIL_CAPS, 20)
    expect(caps.maxItems).toBe(20)
    expect(caps.perItem).toBe(COMPANY_EMAIL_CAPS.perItem)
    // total must allow `limit` full-size threads (so the cap is the real limit).
    expect(caps.total).toBe(COMPANY_EMAIL_CAPS.perItem * 20)
  })

  it('floors the limit at 1', () => {
    expect(emailCapsForLimit(COMPANY_EMAIL_CAPS, 0).maxItems).toBe(1)
  })
})

describe('renderEmailRows (shared renderer + reconstruction + dedup)', () => {
  const longNovel = 'substantive content '.repeat(10)
  function msg(over: Partial<EmailRowForThread>): EmailRowForThread {
    return {
      threadGroup: 'T1',
      messageId: 'm',
      fromEmail: 'a@b.com',
      subject: 'Deal',
      direction: 'inbound',
      bodyText: longNovel,
      receivedAt: '2026-06-01',
      ...over,
    }
  }

  it('reconstructs a thread oldest→newest, each message once', () => {
    const rows: EmailRowForThread[] = [
      msg({ messageId: 'm1', fromEmail: 'founder@acme.com', direction: 'inbound', bodyText: 'ORIGINAL_ASK details here and more text', receivedAt: '2026-06-01' }),
      msg({ messageId: 'm2', fromEmail: 'me@firm.com', direction: 'outbound', bodyText: 'MIDDLE_REPLY with content\n\nOn Jun 1 founder wrote:\n> ORIGINAL_ASK details here and more text', receivedAt: '2026-06-02' }),
      msg({ messageId: 'm3', fromEmail: 'founder@acme.com', direction: 'inbound', bodyText: 'LATEST_TERSE', receivedAt: '2026-06-03' }),
    ]
    const out = renderEmailRows(rows, COMPANY_EMAIL_CAPS)
    expect(out).toContain('ORIGINAL_ASK')
    expect(out).toContain('MIDDLE_REPLY')
    // each message's novel content appears exactly once (no nested re-quote dup)
    expect(out.match(/ORIGINAL_ASK/g)?.length).toBe(1)
    // oldest first
    expect(out.indexOf('ORIGINAL_ASK')).toBeLessThan(out.indexOf('MIDDLE_REPLY'))
  })

  it('cross-block dedup via shared seen set renders a thread once', () => {
    const rows: EmailRowForThread[] = [
      msg({ messageId: 'm1', direction: 'inbound', receivedAt: '2026-06-01' }),
      msg({ messageId: 'm2', direction: 'outbound', receivedAt: '2026-06-02' }),
    ]
    const seen = new Set<string>()
    const first = renderEmailRows(rows, COMPANY_EMAIL_CAPS, seen)
    const second = renderEmailRows(rows, COMPANY_EMAIL_CAPS, seen)
    expect(first).not.toBe('')
    expect(second).toBe('') // already seen → nothing to render
  })

  it('drops low-signal threads (single one-way short body)', () => {
    const rows: EmailRowForThread[] = [
      msg({ threadGroup: 'T9', messageId: 'x', direction: 'inbound', bodyText: 'hi', receivedAt: '2026-06-01' }),
    ]
    expect(renderEmailRows(rows, COMPANY_EMAIL_CAPS)).toBe('')
  })

  it('returns empty string for no rows', () => {
    expect(renderEmailRows([], COMPANY_EMAIL_CAPS)).toBe('')
  })
})
