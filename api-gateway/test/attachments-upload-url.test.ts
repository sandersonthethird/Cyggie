import { afterAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'

// POST /attachments/upload-url — presigned PUT minting.
//
// HERMETIC: the S3 presigner is mocked (decision 3A) so no real R2 is hit. These
// tests cover the AUTH/validation logic — key derivation from JWT.sub (IDOR
// guard), mime allowlist, size cap, id-shape, and fail-closed-when-unconfigured —
// which is the actual risk surface. The presign signature / bucket CORS is
// validated by the ONE manual real-R2 smoke in the PR1 checklist, not here.

// Mock BEFORE importing the app (vi.mock is hoisted). getSignedUrl is the only
// thing that would touch R2; return a deterministic fake signed URL.
const getSignedUrlMock = vi.fn(
  async () =>
    'https://test-account.r2.cloudflarestorage.com/attachments/signed?X-Amz-Signature=test',
)
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}))

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
// R2 config — fake but well-formed so the route is "configured".
process.env['R2_ACCOUNT_ID'] = 'test-account'
process.env['R2_ACCESS_KEY_ID'] = 'test-access-key'
process.env['R2_SECRET_ACCESS_KEY'] = 'test-secret-key'
process.env['R2_BUCKET'] = 'cyggie-attachments-test'
process.env['R2_ENDPOINT'] = 'https://test-account.r2.cloudflarestorage.com'
process.env['ATTACHMENT_MAX_UPLOAD_BYTES'] = String(25 * 1024 * 1024)

// Force-required env vars that aren't set in .env.local.
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'
if (!process.env['DEEPGRAM_WEBHOOK_SECRET'])
  process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()

afterAll(async () => {
  await app.close()
})

async function mintJwt(sub: string, firmId: string | null = 'firm-test'): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub,
    sid: 'sess-' + sub,
    device: 'test-device',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    attachmentId: createId().slice(0, 24),
    contentType: 'image/png',
    sizeBytes: 1024,
    ...over,
  }
}

describe('POST /attachments/upload-url', () => {
  test('valid request returns a presigned URL + JWT-scoped storage key', async () => {
    const sub = 'user-' + createId().slice(0, 8)
    const jwt = await mintJwt(sub)
    const body = validBody()
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const json = res.json() as { url: string; storageKey: string; expiresInSeconds: number }
    expect(json.url).toContain('https://')
    // IDOR guard: key is derived from JWT.sub, not anything client-supplied.
    expect(json.storageKey).toBe(`attachments/${sub}/${body.attachmentId}`)
    expect(json.expiresInSeconds).toBe(env.ATTACHMENT_PRESIGN_TTL_SECONDS)
  })

  test('storage key ignores the caller and always uses their own JWT.sub', async () => {
    // Two different users minting for the same attachmentId get DISTINCT keys —
    // a user can never sign into another user's prefix.
    const id = createId().slice(0, 24)
    const a = await mintJwt('user-aaa')
    const b = await mintJwt('user-bbb')
    const resA = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${a}` },
      payload: validBody({ attachmentId: id }),
    })
    const resB = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${b}` },
      payload: validBody({ attachmentId: id }),
    })
    expect((resA.json() as { storageKey: string }).storageKey).toBe(`attachments/user-aaa/${id}`)
    expect((resB.json() as { storageKey: string }).storageKey).toBe(`attachments/user-bbb/${id}`)
  })

  test('unauthenticated request is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      payload: validBody(),
    })
    expect(res.statusCode).toBe(401)
  })

  test('disallowed mime (SVG) is rejected 400', async () => {
    const jwt = await mintJwt('user-svg')
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      payload: validBody({ contentType: 'image/svg+xml' }),
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('UNSUPPORTED_MIME_TYPE')
  })

  test('PDF mime is allowed', async () => {
    const jwt = await mintJwt('user-pdf')
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      payload: validBody({ contentType: 'application/pdf' }),
    })
    expect(res.statusCode).toBe(200)
  })

  test('oversize upload is rejected 413', async () => {
    const jwt = await mintJwt('user-big')
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      payload: validBody({ sizeBytes: env.ATTACHMENT_MAX_UPLOAD_BYTES + 1 }),
    })
    expect(res.statusCode).toBe(413)
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('UPLOAD_TOO_LARGE')
  })

  test('zero-byte upload is rejected (schema: positive)', async () => {
    const jwt = await mintJwt('user-zero')
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      payload: validBody({ sizeBytes: 0 }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('malformed attachmentId is rejected 400', async () => {
    const jwt = await mintJwt('user-badid')
    const res = await app.inject({
      method: 'POST',
      url: '/attachments/upload-url',
      headers: { authorization: `Bearer ${jwt}` },
      // Uppercase + symbols violate the cuid2 shape guard.
      payload: validBody({ attachmentId: 'NOT/A/VALID*ID' }),
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('INVALID_ATTACHMENT_ID')
  })
})

describe('POST /attachments/upload-url — fail closed when R2 unconfigured', () => {
  test('returns 503 STORAGE_NOT_CONFIGURED', async () => {
    // Build a second app from an env clone with R2 vars cleared.
    const noR2Env = {
      ...env,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    } as typeof env
    const noR2App = await buildApp(noR2Env)
    await noR2App.ready()
    try {
      const jwt = await mintJwt('user-nor2')
      const res = await noR2App.inject({
        method: 'POST',
        url: '/attachments/upload-url',
        headers: { authorization: `Bearer ${jwt}` },
        payload: validBody(),
      })
      expect(res.statusCode).toBe(503)
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('STORAGE_NOT_CONFIGURED')
    } finally {
      await noR2App.close()
    }
  })
})
