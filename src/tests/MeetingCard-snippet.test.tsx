// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import { FTS_MARK_START, FTS_MARK_END } from '../shared/constants/search-markers'

// MeetingCard pulls in route-level types and a CSS module. The card body
// itself isn't under test — only the snippet render path — so mock the
// CSS module to silence Vitest's "unknown file extension .css" error.
vi.mock('../renderer/components/meetings/MeetingCard.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const { default: MeetingCard } = await import('../renderer/components/meetings/MeetingCard')

afterEach(() => cleanup())

const BASE_MEETING = {
  id: 'm1',
  title: 'Test meeting',
  date: '2026-05-16T10:00:00Z',
  durationSeconds: 1800,
  speakerMap: {},
  attendees: ['Alice'],
  attendeeEmails: [],
} as unknown as React.ComponentProps<typeof MeetingCard>['meeting']

function wrap(match: string): string {
  return `${FTS_MARK_START}${match}${FTS_MARK_END}`
}

const NOOP = () => {}

describe('MeetingCard snippet rendering', () => {
  it('renders sentinel-wrapped substrings as <mark> nodes', () => {
    const snippet = `pre ${wrap('match')} post`
    const { container } = render(
      <MeetingCard meeting={BASE_MEETING} snippet={snippet} onClick={NOOP} onDelete={NOOP} onCopyLink={NOOP} />
    )
    const marks = container.querySelectorAll('mark')
    expect(marks.length).toBe(1)
    expect(marks[0].textContent).toBe('match')
  })

  it('renders literal <mark> in transcript text as escaped text (no false highlight)', () => {
    const snippet = `body contains <mark>not-a-highlight</mark> and ${wrap('real-match')}`
    const { container } = render(
      <MeetingCard meeting={BASE_MEETING} snippet={snippet} onClick={NOOP} onDelete={NOOP} onCopyLink={NOOP} />
    )
    const marks = container.querySelectorAll('mark')
    expect(marks.length).toBe(1)
    expect(marks[0].textContent).toBe('real-match')
    // The literal <mark> text appears as escaped text content somewhere
    expect(container.textContent).toContain('<mark>not-a-highlight</mark>')
  })

  it('does not execute <script> in snippet body', () => {
    const snippet = `before <script>alert(1)</script> after ${wrap('hit')}`
    const { container } = render(
      <MeetingCard meeting={BASE_MEETING} snippet={snippet} onClick={NOOP} onDelete={NOOP} onCopyLink={NOOP} />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('handles multiple sentinel pairs', () => {
    const snippet = `${wrap('a')} mid ${wrap('b')} end ${wrap('c')}`
    const { container } = render(
      <MeetingCard meeting={BASE_MEETING} snippet={snippet} onClick={NOOP} onDelete={NOOP} onCopyLink={NOOP} />
    )
    const marks = container.querySelectorAll('mark')
    expect(marks.length).toBe(3)
    expect([...marks].map((m) => m.textContent)).toEqual(['a', 'b', 'c'])
  })

  it('renders zero <mark> elements when the snippet has no sentinels', () => {
    const { container } = render(
      <MeetingCard meeting={BASE_MEETING} snippet="just plain text" onClick={NOOP} onDelete={NOOP} onCopyLink={NOOP} />
    )
    expect(container.querySelectorAll('mark').length).toBe(0)
  })
})
