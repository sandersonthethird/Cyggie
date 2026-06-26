/**
 * useFirmTemplate — mounts once in Layout and runs the idempotent firm-template
 * seed (default views / labels / field options) for the current firm.
 *
 * The firm's template id will ride the auth token once `firms.template_id` is
 * wired through the gateway; until then `readFirmTemplateId()` returns null and
 * `applyFirmTemplate` resolves to the `vc` default — which preserves today's
 * Red Swan setup (re-homes the Fund IV saved view via the template mechanism
 * instead of the old hardcoded Companies.tsx effect).
 *
 * Stores load lazily and idempotently here, so the hook is self-contained and
 * doesn't depend on bootstrap ordering. The 2B marker (synced user_preferences)
 * makes the seed run at most once per firm-template across devices.
 */
import { useEffect, useRef } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import { ensureView } from '../components/crm/ViewsBar'
import { addCustomFieldOption } from '../utils/customFieldUtils'
import { applyFirmTemplate, type ApplyFirmTemplateDeps } from '../lib/applyFirmTemplate'

const COMPANY_VIEWS_KEY = 'cyggie:company-views'
const COMPANY_LABELS_KEY = 'cyggie:column-label-overrides:company'

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

/** Source of the firm's template id. Returns null until `firms.template_id`
 *  rides the auth token (deferred) → applyFirmTemplate falls back to `vc`. */
function readFirmTemplateId(): string | null {
  return null
}

export function useFirmTemplate(): void {
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      try {
        await Promise.all([
          usePreferencesStore.getState().load(),
          useCustomFieldStore.getState().load(),
        ])
        await applyFirmTemplate(readFirmTemplateId(), buildDeps())
      } catch (e) {
        // Best-effort: never let template seeding break app mount.
        console.warn('[firm-template] seed run failed', e)
      }
    })()
  }, [])
}
