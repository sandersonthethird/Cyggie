import { describe, expect, test, vi } from 'vitest'
import { createSseParser, type SseEvent } from '../sse'

function collect(): {
  parser: (chunk: string, flush?: boolean) => void
  events: SseEvent[]
} {
  const events: SseEvent[] = []
  const parser = createSseParser((ev) => events.push(ev))
  return { parser, events }
}

describe('createSseParser', () => {
  test('parses a single complete event', () => {
    const { parser, events } = collect()
    parser('event: token\ndata: {"text":"Hi"}\n\n')
    expect(events).toEqual([{ event: 'token', data: '{"text":"Hi"}' }])
  })

  test('handles multiple events in one chunk', () => {
    const { parser, events } = collect()
    parser(
      'event: token\ndata: a\n\nevent: token\ndata: b\n\nevent: done\ndata: {}\n\n',
    )
    expect(events).toEqual([
      { event: 'token', data: 'a' },
      { event: 'token', data: 'b' },
      { event: 'done', data: '{}' },
    ])
  })

  test('buffers across split chunks (event split at boundary)', () => {
    const { parser, events } = collect()
    parser('event: token\nda')
    expect(events).toHaveLength(0)
    parser('ta: {"text":"split"}\n\n')
    expect(events).toEqual([{ event: 'token', data: '{"text":"split"}' }])
  })

  test('buffers across newline boundary (split between lines)', () => {
    const { parser, events } = collect()
    parser('event: token\n')
    parser('data: hi\n\n')
    expect(events).toEqual([{ event: 'token', data: 'hi' }])
  })

  test('skips malformed lines without a colon', () => {
    const { parser, events } = collect()
    parser('garbage no colon here\nevent: token\ndata: ok\n\n')
    expect(events).toEqual([{ event: 'token', data: 'ok' }])
  })

  test('defaults event name to "message" when event: is absent', () => {
    const { parser, events } = collect()
    parser('data: hello\n\n')
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  test('flush flag dispatches buffered event without trailing newline', () => {
    const { parser, events } = collect()
    parser('event: done\ndata: {}', /* flush */ false)
    expect(events).toHaveLength(0) // no trailing \n\n yet
    parser('', /* flush */ true)
    expect(events).toEqual([{ event: 'done', data: '{}' }])
  })

  test('joins multi-line data with newlines (rare but per-spec)', () => {
    const { parser, events } = collect()
    parser('data: line1\ndata: line2\n\n')
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
  })

  test('handles tokens streamed one byte per chunk', () => {
    const { parser, events } = collect()
    const wholeStream = 'event: token\ndata: hi\n\n'
    for (const ch of wholeStream) parser(ch)
    expect(events).toEqual([{ event: 'token', data: 'hi' }])
  })

  test('callback receives events in order', () => {
    const cb = vi.fn()
    const parser = createSseParser(cb)
    parser('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb.mock.calls[0]?.[0]).toEqual({ event: 'a', data: '1' })
    expect(cb.mock.calls[1]?.[0]).toEqual({ event: 'b', data: '2' })
  })
})
