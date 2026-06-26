/**
 * applyFirmTemplate — idempotent, best-effort per-device seeding of a firm's
 * template config (default views, labels, builtin field options).
 *
 *   resolve template (null/unknown → vc)
 *        │
 *   marker `template_applied:<id>` already set? ──yes──▶ skip (no-op)
 *        │ no
 *        ▼
 *   seed views ─┐
 *   seed labels ─┼─ each target try/caught; a failure flips allOk=false
 *   seed options ┘   (option writes go through the synced addCustomFieldOption path)
 *        │
 *   allOk ? set marker (so it never re-runs / never resurrects deleted opts)
 *         : leave marker UNSET (retries next load)
 *
 * The marker lives in the synced user_preferences store (2B), so once any device
 * seeds, others skip — and a user-deleted option is never re-added. Seeding never
 * throws to the caller: a bad target degrades to "retry next load", never a crash.
 */
import { resolveFirmTemplate, type TemplateSavedView } from '../../shared/firm-templates'

export interface ApplyFirmTemplateDeps {
  /** Read the synced 2B marker (returns null if unset). */
  getMarker: (key: string) => string | null
  /** Persist the synced 2B marker. */
  setMarker: (key: string, value: string) => void
  /** Add a company saved view if absent (ViewsBar.ensureView). */
  ensureCompanyView: (view: TemplateSavedView) => void
  /** Merge company column label overrides (per-device store). */
  mergeCompanyLabels: (overrides: Record<string, string>) => void
  /** Look up a builtin company custom-field def by fieldKey (for option seeding). */
  getCompanyBuiltinDef: (fieldKey: string) => { id: string; optionsJson: string | null } | undefined
  /** Add one option to a field def via the synced write path. */
  addCompanyFieldOption: (defId: string, currentOptionsJson: string | null, option: string) => Promise<void>
  /** ISO timestamp for the marker value (injectable for tests). */
  now: () => string
  /** Structured logger for best-effort failures. */
  log: (message: string, ctx: Record<string, unknown>) => void
}

export interface ApplyFirmTemplateResult {
  templateId: string
  /** false when the marker was already set (skipped). */
  ran: boolean
  /** true when every seed target succeeded (marker then set). */
  allOk: boolean
}

export async function applyFirmTemplate(
  templateIdRaw: string | null | undefined,
  deps: ApplyFirmTemplateDeps,
): Promise<ApplyFirmTemplateResult> {
  const template = resolveFirmTemplate(templateIdRaw)
  const markerKey = `template_applied:${template.id}`

  if (deps.getMarker(markerKey) != null) {
    return { templateId: template.id, ran: false, allOk: true }
  }

  let allOk = true
  const fail = (target: string, error: unknown): void => {
    allOk = false
    deps.log('[firm-template] seed target failed', { templateId: template.id, target, error: String(error) })
  }

  // 1. Default saved views (localStorage, per-device; add-if-id-absent).
  for (const view of template.companyViews) {
    try { deps.ensureCompanyView(view) } catch (e) { fail(`view:${view.id}`, e) }
  }

  // 2. Label overrides (per-device store).
  if (Object.keys(template.companyLabelOverrides).length > 0) {
    try { deps.mergeCompanyLabels(template.companyLabelOverrides) } catch (e) { fail('labels', e) }
  }

  // 3. Builtin field option lists (synced via addCompanyFieldOption). The
  //    builtin def must already exist (seeded by migration); if it doesn't,
  //    record a failure so the seed retries once the def syncs in.
  for (const { fieldKey, options } of template.companyFieldOptions) {
    const def = deps.getCompanyBuiltinDef(fieldKey)
    if (!def) { fail(`builtin-def-missing:${fieldKey}`, new Error('no builtin def')); continue }
    for (const opt of options) {
      try {
        const current = deps.getCompanyBuiltinDef(fieldKey)?.optionsJson ?? def.optionsJson
        await deps.addCompanyFieldOption(def.id, current, opt)
      } catch (e) { fail(`option:${fieldKey}:${opt}`, e) }
    }
  }

  // 2B marker only on full success — partial failures retry on the next load.
  if (allOk) deps.setMarker(markerKey, deps.now())

  return { templateId: template.id, ran: true, allOk }
}
