// =============================================================================
// custom-field-values.ts — canonical (de)serialization for custom field values.
//
// Custom field values are persisted as a single TEXT column (value_text for
// custom_field_values; the native column for builtin fields like
// org_companies.target_investment_stage). For `multiselect` the canonical wire
// format is a COMMA-joined string — the same shape PropertyRow writes via
// `draftSelected.join(',')`. A prior enrichment bug stored multiselect values as
// `JSON.stringify(array)` instead, which leaked brackets/quotes into the UI and
// broke option matching. These helpers are the ONE place that parse/serialize so
// the JSON-vs-comma split can never re-diverge.
//
//   parse:      '["Seed","Series A"]' | 'Seed,Series A'  ─►  ['Seed','Series A']
//   serialize:  ['Seed','Series A']                       ─►  'Seed,Series A'
//   merge:      union of any number of the above, deduped, in canonical order
// =============================================================================

import type { SetCustomFieldValueInput } from './types/custom-fields'

/**
 * Canonical ordering for investment-stage multiselect values. Used to render a
 * merged value deterministically (so the same set always serializes identically,
 * which matters for sync diffing). Mirrors TARGET_INVESTMENT_STAGES in
 * companyColumns.ts — values are human-readable labels (value === label).
 */
export const CANONICAL_STAGE_ORDER = [
  'Pre-Seed',
  'Seed',
  'Series A',
  'Series B',
  'Series C',
  'Growth',
  'Late Stage',
] as const

/**
 * Parse a stored multiselect value into its member strings, tolerating BOTH the
 * canonical comma form AND the legacy JSON-array form (so existing corrupted rows
 * still render and remain editable). Returns [] for empty/blank input.
 */
export function parseMultiselectValue(raw: unknown): string[] {
  const s = String(raw ?? '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) {
        return arr.map((x) => String(x).trim()).filter(Boolean)
      }
    } catch {
      /* malformed JSON — fall through to comma split */
    }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** The value_* fields of SetCustomFieldValueInput a serializer can populate. */
export type CustomFieldValueParts = Pick<
  SetCustomFieldValueInput,
  'valueText' | 'valueNumber' | 'valueBoolean' | 'valueDate'
>

/**
 * Convert an AI/extracted value into the correct `value_*` field for a given
 * field type. Multiselect → comma-joined string (canonical), matching manual
 * edits. This is the single serializer used by every enrichment apply site.
 */
export function serializeCustomFieldValue(
  fieldType: string,
  v: unknown,
): CustomFieldValueParts {
  switch (fieldType) {
    case 'number':
    case 'currency':
      return { valueNumber: v == null || v === '' ? null : Number(v) }
    case 'boolean':
      return { valueBoolean: Boolean(v) }
    case 'date':
      return { valueDate: v == null ? null : String(v) }
    case 'multiselect':
      return {
        valueText: Array.isArray(v)
          ? v.map((x) => String(x).trim()).filter(Boolean).join(',')
          : v == null
            ? null
            : String(v),
      }
    default:
      return { valueText: v == null ? null : String(v) }
  }
}

/**
 * Merge any number of stored/raw multiselect values (comma OR JSON form) plus an
 * existing value into one canonical comma-joined string: deduped, ordered by
 * CANONICAL_STAGE_ORDER, with any non-canonical option dropped. Returns '' when
 * the union is empty. Pure — the unit of the consolidation backfill.
 */
export function mergeStageValues(existing: unknown, ...rawValues: unknown[]): string {
  const seen = new Set<string>()
  for (const raw of [existing, ...rawValues]) {
    for (const v of parseMultiselectValue(raw)) seen.add(v)
  }
  const ordered = CANONICAL_STAGE_ORDER.filter((opt) => seen.has(opt))
  return ordered.join(',')
}
