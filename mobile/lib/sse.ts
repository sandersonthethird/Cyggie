// =============================================================================
// sse.ts — tiny SSE parser used by sendSessionMessageStream.
//
// The gateway's POST /chat/sessions/:id/messages (when opted into
// streaming via Accept: text/event-stream) emits events like:
//
//   event: token
//   data: {"text":"Hello"}
//
//   event: token
//   data: {"text":" world"}
//
//   event: done
//   data: {"session":{...},"userMessage":{...},"assistantMessage":{...}}
//
// Events are separated by double-newlines. A `data:` line is the
// JSON payload (we don't bother with multi-line `data:` reassembly
// per the SSE spec — the gateway only emits single-line data).
//
// React Native's fetch supports streaming via response.body.getReader();
// chunks arrive as Uint8Array and may split events at arbitrary byte
// boundaries. The parser is stateful: callers feed in a TextDecoder
// output string and we hold any incomplete tail in a closure so the
// next chunk's prefix joins correctly.
//
// Pure parsing — no fetch, no I/O. Test-friendly.
// =============================================================================

export interface SseEvent {
  /** Event name from the `event:` line, defaults to 'message' if absent. */
  event: string
  /** Raw payload from the `data:` line. JSON-parsed by the caller. */
  data: string
}

/**
 * Stateful SSE parser. Returns a function that consumes string chunks
 * and dispatches each completed event via onEvent. Holds incomplete
 * trailing input across calls.
 *
 * Usage:
 *   const consume = createSseParser((ev) => dispatch(ev))
 *   const reader = response.body!.getReader()
 *   const decoder = new TextDecoder()
 *   while (true) {
 *     const { value, done } = await reader.read()
 *     if (done) break
 *     consume(decoder.decode(value, { stream: true }))
 *   }
 *   // optional flush of any final event without trailing newline:
 *   consume('', true)
 */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string, flush?: boolean) => void {
  let buffer = ''
  return (chunk: string, flush = false): void => {
    buffer += chunk
    // Events terminate with a blank line (double newline). Split into
    // complete blocks; the last (possibly partial) block stays in buffer.
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const ev = parseBlock(block)
      if (ev) onEvent(ev)
    }
    if (flush && buffer.trim().length > 0) {
      const ev = parseBlock(buffer)
      if (ev) onEvent(ev)
      buffer = ''
    }
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message'
  let data: string | null = null
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue // comment / blank
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue // malformed; skip per spec
    const field = line.slice(0, colonIdx)
    // Per spec: optional single space after colon is stripped.
    const value = line.slice(colonIdx + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') {
      // Multi-line `data:` should be joined with \n per spec. Rare in
      // our gateway (we emit single-line JSON) but handle for correctness.
      data = data == null ? value : `${data}\n${value}`
    }
    // Ignore id, retry — unused by our gateway.
  }
  if (data == null) return null
  return { event, data }
}
