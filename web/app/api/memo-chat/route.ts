import Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../../../lib/db'
import { sharedMemos } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { decryptApiKey } from '../../../lib/crypto'
import { checkMemoRateLimit } from '../../../lib/rate-limit'

export const runtime = 'edge'

const SYSTEM_PROMPT = `You are a helpful investment analyst assistant. You have access to an investment memo provided between <memo> tags. Answer questions accurately based only on the memo content. If the answer isn't in the memo, say so clearly. Do not speculate beyond what the memo states.`

interface ChatRequest {
  token: string
  question: string
  history?: { role: 'user' | 'assistant'; content: string }[]
}

export async function POST(request: Request) {
  let body: ChatRequest
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!body.token || !body.question) {
    return new Response(JSON.stringify({ error: 'Missing token or question' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rows = await getDb()
    .select()
    .from(sharedMemos)
    .where(and(eq(sharedMemos.token, body.token), eq(sharedMemos.isActive, true)))
    .limit(1)

  const memo = rows[0]
  if (!memo) {
    return new Response(JSON.stringify({ error: 'Share not found or inactive' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (memo.expiresAt && new Date(memo.expiresAt) < new Date()) {
    return new Response(JSON.stringify({ error: 'This share link has expired' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { allowed, remaining } = await checkMemoRateLimit(body.token)
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Daily chat limit reached. Please try again tomorrow.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': '0',
        },
      }
    )
  }

  let apiKey: string
  try {
    apiKey = await decryptApiKey(memo.apiKeyEnc)
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to decrypt API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const client = new Anthropic({ apiKey })

  const userContent = `<memo>\n# ${memo.title}\nCompany: ${memo.companyName}\n\n${memo.contentMarkdown}\n</memo>\n\n---\n\nQuestion: ${body.question}`

  const messages: Anthropic.MessageParam[] = [
    ...(body.history || []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: userContent },
  ]

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          stream: true,
          system: SYSTEM_PROMPT,
          messages,
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
      'X-RateLimit-Remaining': String(remaining),
    },
  })
}
