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
