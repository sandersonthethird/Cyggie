import { NextResponse } from 'next/server'
import { getDb } from '../../../lib/db'
import { sharedMeetings, rateLimits } from '../../../drizzle/schema'
import { encryptApiKey, generateToken } from '../../../lib/crypto'

interface ShareRequest {
  title: string
  date: string
  durationSeconds: number | null
  speakerMap: Record<string, string>
  attendees: string[] | null
  summary: string | null
  transcript: string
  notes: string | null
  claudeApiKey: string
  expiresInDays?: number
}

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.SHARE_API_SECRET
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ShareRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.transcript || !body.claudeApiKey || !body.title) {
    return NextResponse.json(
      { error: 'Missing required fields: transcript, claudeApiKey, title' },
      { status: 400 }
    )
  }

  const token = generateToken()
  const apiKeyEnc = await encryptApiKey(body.claudeApiKey)
  const expiresInDays = body.expiresInDays ?? 30
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  await getDb().insert(sharedMeetings).values({
    token,
    title: body.title,
    date: new Date(body.date),
    durationSeconds: body.durationSeconds,
    speakerMap: body.speakerMap ?? {},
    attendees: body.attendees,
    summary: body.summary,
    transcript: body.transcript,
    notes: body.notes,
    apiKeyEnc,
    expiresAt,
  })

  await getDb().insert(rateLimits).values({
    token,
    chatCountDay: 0,
    lastReset: new Date().toISOString().split('T')[0],
    totalQueries: 0,
  })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cyggie.vercel.app'
  const url = `${baseUrl}/s/${token}`

  return NextResponse.json({ success: true, token, url })
}
