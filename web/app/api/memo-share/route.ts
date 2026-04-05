import { NextResponse } from 'next/server'
import { getDb } from '../../../lib/db'
import { sharedMemos, memoRateLimits } from '../../../drizzle/schema'
import { encryptApiKey, generateToken } from '../../../lib/crypto'
import { eq } from 'drizzle-orm'

interface MemoShareRequest {
  title: string
  companyName: string
  contentMarkdown: string
  claudeApiKey: string
  logoUrl?: string | null
  companyLogoUrl?: string | null
  expiresInDays?: number
}

function auth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.SHARE_API_SECRET
  return !!expectedSecret && authHeader === `Bearer ${expectedSecret}`
}

export async function POST(request: Request) {
  if (!auth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: MemoShareRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.contentMarkdown || !body.claudeApiKey || !body.title || !body.companyName) {
    return NextResponse.json(
      { error: 'Missing required fields: title, companyName, contentMarkdown, claudeApiKey' },
      { status: 400 }
    )
  }

  let apiKeyEnc: string
  try {
    apiKeyEnc = await encryptApiKey(body.claudeApiKey)
  } catch {
    return NextResponse.json({ error: 'Failed to encrypt API key' }, { status: 500 })
  }

  const expiresInDays = body.expiresInDays ?? 30
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  // Retry on token collision (extremely unlikely with 12-char base62)
  let token = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    token = generateToken()
    try {
      await getDb().insert(sharedMemos).values({
        token,
        title: body.title,
        companyName: body.companyName,
        contentMarkdown: body.contentMarkdown,
        logoUrl: body.logoUrl ?? null,
        companyLogoUrl: body.companyLogoUrl ?? null,
        apiKeyEnc,
        expiresAt,
      })
      break
    } catch (err: unknown) {
      const isUniqueViolation =
        err instanceof Error && err.message.includes('unique')
      if (!isUniqueViolation || attempt === 2) {
        return NextResponse.json({ error: 'Failed to create share' }, { status: 500 })
      }
    }
  }

  await getDb().insert(memoRateLimits).values({
    token,
    chatCountDay: 0,
    lastReset: new Date().toISOString().split('T')[0],
    totalQueries: 0,
  })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cyggie.vercel.app'
  const url = `${baseUrl}/m/${token}`

  return NextResponse.json({ success: true, token, url })
}

export async function PATCH(request: Request) {
  if (!auth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { token: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.token) {
    return NextResponse.json({ error: 'Missing required field: token' }, { status: 400 })
  }

  await getDb()
    .update(sharedMemos)
    .set({ isActive: false })
    .where(eq(sharedMemos.token, body.token))

  return NextResponse.json({ success: true })
}
