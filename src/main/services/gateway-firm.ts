import { getAccessToken, refresh as refreshCyggieAuth } from '../auth/cyggie-auth'

// Slice B (multi-firm) — desktop → gateway read of the firm's template id.
//
// The renderer seeds the firm-type template (default views / labels / field
// options) via applyFirmTemplate. It needs the firm's `template_id`, which lives
// on the Neon `firms` row and is surfaced by GET /firms/me. `firms` is auth
// metadata (outside the outbox), so this uses the same dedicated-GET +
// 401→refresh→retry pattern as gateway-profile.ts / gateway-credentials.ts.
//
// Returns a discriminated result so the renderer can tell "couldn't read"
// (offline / pre-firm 403 / gateway down → SKIP seeding, self-heal next launch)
// from "read successfully, value is null" (firm exists, pre-Slice-B → seed 'vc'):
//
//   { ok: true, templateId } → seed resolveFirmTemplate(templateId)
//   { ok: false }            → skip; do NOT blindly seed a default we couldn't confirm

const GATEWAY_URL = process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export type FirmTemplateFetchResult =
  | { ok: true; templateId: string | null }
  | { ok: false }

export async function fetchFirmTemplateId(): Promise<FirmTemplateFetchResult> {
  const tokenA = await getAccessToken()
  if (!tokenA) return { ok: false }

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/firms/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) return { ok: false }
      res = await tryOnce(fresh)
    }
    // 403 = NO_FIRM (requireFirm) — user authed but pre-onboarding. Skip seeding.
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { template_id?: string | null }
    return { ok: true, templateId: body.template_id ?? null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-firm] /firms/me fetch failed err=${msg}`)
    return { ok: false }
  }
}

/**
 * Best-effort firm name for the onboarding Storage step's member info line
 * ("Shared files go to your firm's <name> folder"). Same /firms/me GET +
 * 401→refresh→retry pattern. Returns null on any failure (the UI falls back to
 * a generic phrasing).
 */
export async function fetchFirmName(): Promise<string | null> {
  const tokenA = await getAccessToken()
  if (!tokenA) return null

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/firms/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) return null
      res = await tryOnce(fresh)
    }
    if (!res.ok) return null
    const body = (await res.json()) as { name?: string | null }
    return typeof body.name === 'string' && body.name.length > 0 ? body.name : null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-firm] /firms/me name fetch failed err=${msg}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier storage (Slice 2) — the firm-wide SHARED files location.
//
// Stored on Neon as a MOUNT-RELATIVE Drive spec; each client resolves rel_path
// against its own CloudStorage mount (see storage/shared-root.ts). Same
// dedicated-GET + 401→refresh→retry discipline as fetchFirmTemplateId above.
//
//   { ok: true, config }        → resolve + use as the shared root
//   { ok: true, config: null }  → firm exists but admin hasn't set a folder yet
//   { ok: false }               → offline / pre-firm 403 / gateway down (don't guess)
// ─────────────────────────────────────────────────────────────────────────────

export interface FirmStorageSpec {
  provider: 'gdrive'
  relPath: string
}

export type FirmStorageConfigFetchResult =
  | { ok: true; config: FirmStorageSpec | null }
  | { ok: false }

export async function fetchFirmStorageConfig(): Promise<FirmStorageConfigFetchResult> {
  const tokenA = await getAccessToken()
  if (!tokenA) return { ok: false }

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/firms/me/storage-config`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) return { ok: false }
      res = await tryOnce(fresh)
    }
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as {
      storage_config?: { provider?: string; rel_path?: string } | null
    }
    const sc = body.storage_config
    if (!sc || sc.provider !== 'gdrive' || typeof sc.rel_path !== 'string') {
      return { ok: true, config: null }
    }
    return { ok: true, config: { provider: 'gdrive', relPath: sc.rel_path } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-firm] /firms/me/storage-config fetch failed err=${msg}`)
    return { ok: false }
  }
}

/** Admin sets the firm-wide shared location. Returns ok=false on any failure
 *  (caller surfaces it — this is an explicit user action, not best-effort). */
export async function putFirmStorageConfig(relPath: string): Promise<{ ok: boolean }> {
  const tokenA = await getAccessToken()
  if (!tokenA) return { ok: false }

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/firms/me/storage-config`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gdrive', rel_path: relPath }),
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) return { ok: false }
      res = await tryOnce(fresh)
    }
    return { ok: res.ok }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-firm] PUT /firms/me/storage-config failed err=${msg}`)
    return { ok: false }
  }
}
