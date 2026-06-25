export const FEATURE_FLAG_DEFAULTS = {
  ff_company_model_v1: true,
  ff_companies_ui_v1: true,
  ff_company_notes_v1: true,
  ff_investment_memo_v1: true,
  ff_company_chat_v1: true,
  ff_email_ui_v1: true,
  ff_themes_ui_v1: false,
  ff_pipeline_ui_v1: true,
  ff_artifacts_ui_v1: false,
  ff_ask_unified_v1: true,
  ff_email_ingest_v1: false,
  ff_crm_sync_read_v1: false,
  ff_crm_v2: true,
  // M5 — paste/drag/insert images into the note editor (bytes → R2, synced).
  // OFF until PR1/PR2 are confirmed live and the upload path is verified, so a
  // `cyggie-attachment://` reference never enters synced markdown prematurely.
  ff_note_attachments_v1: false
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAG_DEFAULTS

export function parseFeatureFlagValue(
  value: string | null | undefined,
  fallback: boolean
): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}
