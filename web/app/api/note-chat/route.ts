import Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../../../lib/db'
import { sharedNotes } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { decryptApiKey } from '../../../lib/crypto'
import { checkNoteRateLimit } from '../../../lib/rate-limit'
import { createClaudeSSEResponse } from '../../../lib/sse-stream'

export const runtime = 'edge'

const SYSTEM_PROMPT = `You are a helpful assistant. You have access to a note provided between <note> tags. Answer questions accurately based only on the note content. If the answer isn't in the note, say so clearly.`

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
    .from(sharedNotes)
    .where(and(eq(sharedNotes.token, body.token), eq(sharedNotes.isActive, true)))
    .limit(1)

  const note = rows[0]
  if (!note) {
    return new Response(JSON.stringify({ error: 'Share not found or inactive' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (note.expiresAt && new Date(note.expiresAt) < new Date()) {
    return new Response(JSON.stringify({ error: 'This share link has expired' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!note.apiKeyEnc) {
    return new Response(
      JSON.stringify({
        error:
          'This note was shared before AI chat was available. Please re-share the note to enable chat.',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const { allowed, remaining } = await checkNoteRateLimit(body.token)
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
    apiKey = await decryptApiKey(note.apiKeyEnc)
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to decrypt API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const client = new Anthropic({ apiKey })

  const userContent = `<note>\n# ${note.title}\n\n${note.contentMarkdown}\n</note>\n\n---\n\nQuestion: ${body.question}`

  const messages: Anthropic.MessageParam[] = [
    ...(body.history || []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: userContent },
  ]

  return createClaudeSSEResponse(
    client,
    { model: 'claude-sonnet-4-6', system: SYSTEM_PROMPT, messages },
    remaining
  )
}
