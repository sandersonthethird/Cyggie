import Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../../../lib/db'
import { sharedMeetings } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { decryptApiKey } from '../../../lib/crypto'
import { checkRateLimit } from '../../../lib/rate-limit'
import { createClaudeSSEResponse } from '../../../lib/sse-stream'

export const runtime = 'edge'

const SYSTEM_PROMPT = `You are a helpful meeting assistant. You have access to a meeting transcript and summary. Answer questions accurately based on the meeting content. When referencing specific points, cite the speaker and context. If the answer isn't in the meeting content, say so clearly.`

function buildUserPrompt(
  meeting: {
    title: string
    date: Date
    speakerMap: Record<string, string>
    transcript: string
    summary: string | null
    notes: string | null
  },
  question: string
): string {
  const speakerList = Object.entries(meeting.speakerMap)
    .map(([idx, name]) => `Speaker ${Number(idx) + 1}: ${name}`)
    .join('\n')

  let context = `# Meeting: ${meeting.title}\n`
  context += `Date: ${new Date(meeting.date).toLocaleString()}\n`
  if (speakerList) context += `\n## Participants\n${speakerList}\n`
  if (meeting.notes) context += `\n## Meeting Notes\n${meeting.notes}\n`
  if (meeting.summary) context += `\n## Summary\n${meeting.summary}\n`
  context += `\n## Transcript\n${meeting.transcript}\n`
  context += `\n---\n\nQuestion: ${question}`

  return context
}

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

  // Look up the shared meeting
  const rows = await getDb()
    .select()
    .from(sharedMeetings)
    .where(and(eq(sharedMeetings.token, body.token), eq(sharedMeetings.isActive, true)))
    .limit(1)

  const meeting = rows[0]
  if (!meeting) {
    return new Response(JSON.stringify({ error: 'Share not found or expired' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (meeting.expiresAt && new Date(meeting.expiresAt) < new Date()) {
    return new Response(JSON.stringify({ error: 'This share link has expired' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Check rate limit
  const { allowed, remaining } = await checkRateLimit(body.token)
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

  // Decrypt API key and call Claude
  let apiKey: string
  try {
    apiKey = await decryptApiKey(meeting.apiKeyEnc)
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to decrypt API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const client = new Anthropic({ apiKey })

  const messages: Anthropic.MessageParam[] = [
    ...(body.history || []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    {
      role: 'user' as const,
      content: buildUserPrompt(
        {
          title: meeting.title,
          date: meeting.date,
          speakerMap: meeting.speakerMap as Record<string, string>,
          transcript: meeting.transcript,
          summary: meeting.summary,
          notes: meeting.notes,
        },
        body.question
      ),
    },
  ]

  return createClaudeSSEResponse(
    client,
    { model: 'claude-sonnet-4-6', system: SYSTEM_PROMPT, messages },
    remaining
  )
}
