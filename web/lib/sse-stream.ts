import Anthropic from '@anthropic-ai/sdk'

/*
 * Shared Claude SSE streaming utility used by /api/chat, /api/memo-chat, /api/note-chat.
 *
 * Data flow:
 *   client.messages.create(stream: true)
 *     └→ content_block_delta events
 *          └→ encoder.encode(`data: {"text":"..."}`)
 *               └→ ReadableStream → Response
 *                    └→ FloatingChatWidget reader loop
 *                         └→ accumulate → rendered message
 */
export function createClaudeSSEResponse(
  client: Anthropic,
  params: {
    model: string
    system: string
    messages: Anthropic.MessageParam[]
    maxTokens?: number
  },
  remainingQuota: number
): Response {
  const encoder = new TextEncoder()

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = await client.messages.create({
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          stream: true,
          system: params.system,
          messages: params.messages,
        })

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            )
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: err instanceof Error ? err.message : 'Stream error' })}\n\n`
          )
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-RateLimit-Remaining': String(remainingQuota),
    },
  })
}
