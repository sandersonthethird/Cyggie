import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getDb } from '../../../lib/db'
import { appConfig } from '../../../drizzle/schema'
import { WEB_CHAT_MODEL_CONFIG_KEY } from '../../../lib/models'

/**
 * Desktop → web push for firm-scoped config (currently just the web-chat model).
 * Mirrors the share endpoints' shared-secret auth. Upserts
 * app_config (firm_id, 'webChatModel'). Read live by the chat routes.
 */
interface WebConfigRequest {
  firmId: string
  model: string
}

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.SHARE_API_SECRET
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: WebConfigRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const firmId = typeof body.firmId === 'string' ? body.firmId.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!firmId || !model) {
    return NextResponse.json(
      { error: 'Missing required fields: firmId, model' },
      { status: 400 }
    )
  }

  try {
    await getDb()
      .insert(appConfig)
      .values({ firmId, key: WEB_CHAT_MODEL_CONFIG_KEY, value: model })
      .onConflictDoUpdate({
        target: [appConfig.firmId, appConfig.key],
        set: { value: model, updatedAt: sql`now()` },
      })
  } catch {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
