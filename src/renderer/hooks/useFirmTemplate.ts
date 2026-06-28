/**
 * useFirmTemplate — mounts once in Layout and runs the idempotent firm-template
 * seed (default views / labels / field options) for the current firm.
 *
 * Slice B — the firm's template id is read from GET /firms/me (NOT the JWT; that
 * keeps the 5 token-mint sites untouched). `applyFirmTemplate` maps a null/unknown
 * id to the `vc` default, which preserves Red Swan's setup (re-homes the Fund IV
 * saved view via the template mechanism instead of the old hardcoded effect).
 *
 *   mount
 *     │ firmId from auth status (JWT, no network)
 *     ├─ no firmId (pre-onboarding) ──────────────▶ skip
 *     ├─ local marker seeded:<firmId> set ────────▶ skip (no /firms/me fetch)   ◀ 11A
 *     │
 *     ▼ GET /firms/me  (IPC → gateway)
 *     ├─ { ok:false } (offline / 403 / down) ─────▶ skip (self-heal next launch)
 *     └─ { ok:true, templateId } ─────────────────▶ applyFirmTemplate(templateId)
 *                                                     then set marker (after success)
 *
 * Stores load lazily and idempotently here, so the hook is self-contained and
 * doesn't depend on bootstrap ordering. applyFirmTemplate also keeps its own
 * template-keyed 2B marker (synced user_preferences) as the cross-device guard;
 * the firm-id-keyed marker here is the per-launch network-skip guard.
 */
import { useEffect, useRef } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'
import { usePreferencesStore } from '../stores/preferences.store'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import { ensureView } from '../components/crm/ViewsBar'
import { addCustomFieldOption } from '../utils/customFieldUtils'
import { applyFirmTemplate, type ApplyFirmTemplateDeps } from '../lib/applyFirmTemplate'

const COMPANY_VIEWS_KEY = 'cyggie:company-views'
const COMPANY_LABELS_KEY = 'cyggie:column-label-overrides:company'
const seededMarkerKey = (firmId: string): string => `cyggie:firm-template-seeded:${firmId}`

type AuthStatus = { firmId: string | null }
type FirmTemplateFetch = { ok: true; templateId: string | null } | { ok: false }

function buildDeps(): ApplyFirmTemplateDeps {
  return {
    getMarker: (key) => usePreferencesStore.getState().getJSON<string | null>(key, null),
    setMarker: (key, value) => usePreferencesStore.getState().setJSON(key, value),
    ensureCompanyView: (view) => { ensureView(COMPANY_VIEWS_KEY, view) },
    mergeCompanyLabels: (overrides) => {
      let current: Record<string, string> = {}
      try { current = JSON.parse(localStorage.getItem(COMPANY_LABELS_KEY) ?? '{}') } catch { current = {} }
      // Additive + non-destructive: a label the user already set wins over the template.
      localStorage.setItem(COMPANY_LABELS_KEY, JSON.stringify({ ...overrides, ...current }))
    },
    getCompanyBuiltinDef: (fieldKey) => {
      const d = useCustomFieldStore.getState().companyDefs.find((x) => x.isBuiltin && x.fieldKey === fieldKey)
      return d ? { id: d.id, optionsJson: d.optionsJson } : undefined
    },
    addCompanyFieldOption: (defId, current, opt) => addCustomFieldOption(defId, current, opt),
    now: () => new Date().toISOString(),
    log: (message, ctx) => console.warn(message, ctx),
  }
}

export function useFirmTemplate(): void {
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      try {
        // firm_id from the JWT (no network). No firm → pre-onboarding → skip.
        const status = await api.invoke<AuthStatus>(IPC_CHANNELS.CYGGIE_AUTH_STATUS)
        const firmId = status?.firmId ?? null
        if (!firmId) return

        await usePreferencesStore.getState().load()
        // 11A: already seeded for this firm on this device → skip the /firms/me
        // fetch entirely (avoids a scale-to-zero cold-start GET every launch).
        const marker = usePreferencesStore
          .getState()
          .getJSON<string | null>(seededMarkerKey(firmId), null)
        if (marker) return

        const res = await api.invoke<FirmTemplateFetch>(IPC_CHANNELS.FIRM_TEMPLATE_FETCH)
        // Couldn't read the template (offline / pre-firm 403 / gateway down).
        // Skip rather than blindly seed a default we didn't confirm; self-heals.
        if (!res?.ok) return

        await useCustomFieldStore.getState().load()
        await applyFirmTemplate(res.templateId, buildDeps())
        // Mark seeded only AFTER a successful apply, so a mid-seed failure retries.
        usePreferencesStore.getState().setJSON(seededMarkerKey(firmId), new Date().toISOString())
      } catch (e) {
        // Best-effort: never let template seeding break app mount.
        console.warn('[firm-template] seed run failed', e)
      }
    })()
  }, [])
}
