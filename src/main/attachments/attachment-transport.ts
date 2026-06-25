// =============================================================================
// attachment-transport.ts — the ONLY place the desktop talks to R2 / the
// gateway for attachment bytes. The editor, IPC handler, and protocol handler
// go through here, so the transport (presigned URLs today) can be swapped for
// a proxy-through-gateway design later without touching anything else.
//
// Auth mirrors gateway-profile.ts: getAccessToken() → Bearer → 401 → refresh →
// retry once. The gateway derives the R2 key from JWT.sub (never trusts the
// client), so these calls only carry the attachment id / content metadata.
// =============================================================================

import { getAccessToken, refresh as refreshCyggieAuth } from '../auth/cyggie-auth'

const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export interface UploadUrlResult {
  url: string
  storageKey: string
  expiresInSeconds: number
}

export interface DownloadUrlResult {
  url: string
  mimeType: string
  checksum: string | null
  sizeBytes: number
  expiresInSeconds: number
}

export class AttachmentAuthError extends Error {
  constructor(message = 'Not signed in') {
    super(message)
    this.name = 'AttachmentAuthError'
  }
}

/** POST a JSON body to the gateway with Bearer auth + one 401→refresh retry. */
async function authedPost(path: string, body: unknown): Promise<Response> {
  const token = await getAccessToken()
  if (!token) throw new AttachmentAuthError()
  const once = (t: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    })
  let res = await once(token)
  if (res.status === 401) {
    const fresh = await refreshCyggieAuth()
    if (!fresh) throw new AttachmentAuthError('Session expired')
    res = await once(fresh)
  }
  return res
}

/** Mint a presigned PUT URL for a new attachment. */
export async function requestUploadUrl(params: {
  attachmentId: string
  contentType: string
  sizeBytes: number
}): Promise<UploadUrlResult> {
  const res = await authedPost('/attachments/upload-url', params)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`upload-url failed (${res.status}): ${detail.slice(0, 200)}`)
  }
  return (await res.json()) as UploadUrlResult
}

/**
 * Mint a presigned GET URL for an existing attachment, firm-scoped by the
 * gateway. Returns null on 404 (not found / not authorized / soft-deleted) so
 * the caller can show a placeholder rather than throw.
 */
export async function requestDownloadUrl(id: string): Promise<DownloadUrlResult | null> {
  const res = await authedPost(`/attachments/${id}/download-url`, {})
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`download-url failed (${res.status}): ${detail.slice(0, 200)}`)
  }
  return (await res.json()) as DownloadUrlResult
}

/** PUT bytes directly to R2 via a presigned URL. Echoes the signed Content-Type. */
export async function putBytes(
  url: string,
  bytes: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes as unknown as BodyInit,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`R2 PUT failed (${res.status}): ${detail.slice(0, 200)}`)
  }
}

/** GET bytes directly from R2 via a presigned URL. */
export async function getBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`R2 GET failed (${res.status})`)
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}
