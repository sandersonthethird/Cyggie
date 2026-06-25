// =============================================================================
// cyggie-firm.ts — main-process firm onboarding calls to the gateway.
//
// The Cyggie JWT lives in main's safeStorage, so claim/join/invite calls go
// through here (renderer → IPC → these) rather than the renderer holding tokens.
// Authed with getAccessToken + 401→refresh→retry (same pattern as
// gateway-profile.ts). claim/join return a FRESH firm_id-bearing access token →
// we store it so getStatus() reflects the new firm immediately, then broadcast +
// kick the sync/attachment flushers.
// =============================================================================

import {
  getAccessToken,
  refresh as refreshCyggieAuth,
  broadcastStatus,
} from '../auth/cyggie-auth'
import { storeCyggieAccessToken, storeCyggieAction } from '../auth/cyggie-auth-storage'

const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export interface FirmSummary {
  id: string
  name: string
  slug: string
  plan: string
}
export interface Invite {
  id: string
  email: string
  expiresAt: string
}
interface ClaimResult { access_token: string; firm: FirmSummary }
interface JoinResult { access_token: string; firm: FirmSummary }

export class FirmRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FirmRequestError'
  }
}

/** Authed JSON request with one 401→refresh→retry. Throws FirmRequestError on non-2xx. */
async function authedJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const tokenA = await getAccessToken()
  if (!tokenA) throw new FirmRequestError(401, 'NOT_SIGNED_IN', 'Sign in to Cyggie Cloud first.')
  const once = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  let res = await once(tokenA)
  if (res.status === 401) {
    const fresh = await refreshCyggieAuth()
    if (!fresh) throw new FirmRequestError(401, 'SESSION_EXPIRED', 'Session expired — sign in again.')
    res = await once(fresh)
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    throw new FirmRequestError(
      res.status,
      parsed.error?.code ?? `HTTP_${res.status}`,
      parsed.error?.message ?? `Request failed (${res.status}).`,
    )
  }
  return (await res.json()) as T
}

/** After claim/join: persist the fresh firm token, mark returning, broadcast, flush. */
async function applyFirmToken(accessToken: string): Promise<void> {
  storeCyggieAccessToken(accessToken)
  storeCyggieAction('returning')
  broadcastStatus()
  // Drain anything queued while firmless (notes/attachments) now that firm_id is set.
  try {
    const { triggerSyncFlush } = await import('./sync-bootstrap')
    triggerSyncFlush()
  } catch { /* not loaded yet */ }
  try {
    const { triggerAttachmentUploadFlush } = await import('./attachment-upload-flusher.service')
    triggerAttachmentUploadFlush()
  } catch { /* not started yet */ }
}

export async function claimWorkspace(input: {
  name: string
  slug: string
  primaryEmailDomain?: string | null
}): Promise<FirmSummary> {
  const r = await authedJson<ClaimResult>('/auth/firms/claim', 'POST', {
    name: input.name,
    slug: input.slug,
    primary_email_domain: input.primaryEmailDomain ?? null,
  })
  await applyFirmToken(r.access_token)
  return r.firm
}

export async function joinFirm(token: string): Promise<FirmSummary> {
  const r = await authedJson<JoinResult>('/auth/firms/join', 'POST', { token })
  await applyFirmToken(r.access_token)
  return r.firm
}

/** Email-match join (no token) — the server matches a pending invite to the
 *  caller's verified email. The "no email infra" path (M6). */
export async function acceptByEmail(): Promise<FirmSummary> {
  const r = await authedJson<JoinResult>('/auth/firms/accept-by-email', 'POST', {})
  await applyFirmToken(r.access_token)
  return r.firm
}

export async function listInvites(): Promise<Invite[]> {
  const r = await authedJson<{ invites: Invite[] }>('/firms/me/invites', 'GET')
  return r.invites ?? []
}

export async function createInvite(email: string): Promise<{ token: string; deepLink: string | null }> {
  const r = await authedJson<{ token: string; deep_link?: string }>('/firms/me/invites', 'POST', { email })
  return { token: r.token, deepLink: r.deep_link ?? null }
}

export async function revokeInvite(id: string): Promise<void> {
  await authedJson<unknown>(`/firms/me/invites/${id}`, 'DELETE')
}
