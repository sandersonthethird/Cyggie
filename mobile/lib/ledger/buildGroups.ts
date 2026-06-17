// Generic Unified-Ledger renderer: turns a passthrough detail object into the
// grouped rows LedgerCard draws, driven entirely by the shared field registry.
//
//   detail ──▶ for each registry field (in section/order): format → row
//          └─▶ any populated key NOT in the registry or skip-set → MORE row
//
// A new desktop field reaches mobile automatically (gateway passthrough) and
// renders in MORE with a humanized label until it's promoted into the registry.
// Pure module (no React) so it unit-tests directly; LedgerGroup is a TYPE-only
// import so this file never pulls in react-native.

import {
  COMPANY_FIELD_REGISTRY,
  CONTACT_FIELD_REGISTRY,
  COMPANY_FIELD_SKIP_SET,
  CONTACT_FIELD_SKIP_SET,
  type FieldMeta,
  type PillToneName,
  formatCurrency,
  formatScalar,
  formatUnknown,
  humanize,
  humanizeKey,
  isPopulated,
  joinList,
} from '@cyggie/shared/field-registry'
import type { LedgerGroup, LedgerRow, PillSpec, PillTone } from '../../components/LedgerCard'

export type LedgerDetail = Record<string, unknown>

// ── small pure helpers (mirror the per-screen versions) ──────────────────────

function commaJoin(a: unknown, b: unknown): string | null {
  const x = isPopulated(a) ? String(a).trim() : null
  const y = isPopulated(b) ? String(b).trim() : null
  if (x && y) return `${x}, ${y}`
  return x ?? y
}

function domainLabel(primaryDomain: unknown, websiteUrl: unknown): string | null {
  if (typeof primaryDomain === 'string' && primaryDomain.trim()) {
    return primaryDomain.trim().replace(/^www\./i, '')
  }
  if (typeof websiteUrl === 'string' && websiteUrl.trim()) {
    try {
      return new URL(websiteUrl).hostname.replace(/^www\./i, '')
    } catch {
      return websiteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
    }
  }
  return null
}

/** `https://www.linkedin.com/company/initlabs/` → `/company/initlabs` */
function linkedinPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname.replace(/\/$/, '') || u.hostname.replace(/^www\./i, '')
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/^www\.linkedin\.com/i, '').replace(/\/$/, '')
  }
}

function formatCheckRange(min: unknown, max: unknown): string | null {
  const lo = typeof min === 'number' ? min : null
  const hi = typeof max === 'number' ? max : null
  if (lo == null && hi == null) return null
  if (lo != null && hi != null) return `${formatCurrency(lo)}—${formatCurrency(hi)}`
  return formatCurrency((lo ?? hi) as number)
}

function linkLabel(key: string, value: string): string {
  if (key === 'linkedinCompanyUrl' || key === 'linkedinUrl') return linkedinPath(value)
  if (key === 'twitterHandle') return value.startsWith('@') ? value : `@${value}`
  try {
    return new URL(value).hostname.replace(/^www\./i, '')
  } catch {
    return value
  }
}

// ── row construction ─────────────────────────────────────────────────────────

function pillsFor(meta: FieldMeta, detail: LedgerDetail): PillSpec[] | null {
  const raw = detail[meta.key]
  if (!isPopulated(raw)) return null
  const tone = (meta.tone ?? 'neutral') as PillTone

  if (meta.multi) {
    const parts = String(raw)
      .split(/[,·]/)
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length ? parts.map((label) => ({ label, tone })) : null
  }

  const text = meta.humanize ? humanize(String(raw)) : String(raw)
  // contactType: green pill for investors, neutral otherwise.
  const finalTone: PillTone =
    meta.key === 'contactType' ? (raw === 'investor' ? 'green' : 'neutral') : tone
  return [{ label: text, tone: finalTone, dot: meta.dot }]
}

function rowFor(meta: FieldMeta, detail: LedgerDetail): LedgerRow | null {
  // Composite "sentinel" fields built from >1 column.
  if (meta.key === 'hq' || meta.key === 'location') {
    const v = commaJoin(detail['city'], detail['state'])
    return v ? { key: meta.label, value: v } : null
  }
  if (meta.key === 'website') {
    const v = domainLabel(detail['primaryDomain'], detail['websiteUrl'])
    return v ? { key: meta.label, value: v, link: true } : null
  }
  if (meta.key === 'checkSize') {
    const v = formatCheckRange(detail['typicalCheckSizeMin'], detail['typicalCheckSizeMax'])
    return v ? { key: meta.label, value: v } : null
  }

  if (meta.format === 'pills') {
    const pills = pillsFor(meta, detail)
    return pills ? { key: meta.label, pills } : null
  }
  if (meta.format === 'link') {
    const raw = detail[meta.key]
    if (typeof raw !== 'string' || !raw.trim()) return null
    return { key: meta.label, value: linkLabel(meta.key, raw.trim()), link: true }
  }
  if (meta.format === 'list') {
    const v = joinList(detail[meta.key] as string[] | null | undefined)
    return v ? { key: meta.label, value: v } : null
  }
  const v = formatScalar(detail[meta.key], meta.format, meta.humanize)
  return v ? { key: meta.label, value: v } : null
}

function build(
  detail: LedgerDetail,
  registry: readonly FieldMeta[],
  skipSet: ReadonlySet<string>,
): LedgerGroup[] {
  const rowsBySection = new Map<string, LedgerRow[]>()
  const sectionOrder: string[] = []
  const handled = new Set<string>(skipSet)

  const push = (section: string, row: LedgerRow): void => {
    if (!rowsBySection.has(section)) {
      rowsBySection.set(section, [])
      sectionOrder.push(section)
    }
    rowsBySection.get(section)!.push(row)
  }

  for (const meta of registry) {
    handled.add(meta.key) // registry-handled keys never fall to MORE
    const row = rowFor(meta, detail)
    if (row) push(meta.section, row)
  }

  // MORE fallback: genuinely new / un-curated business keys.
  for (const [key, value] of Object.entries(detail)) {
    if (handled.has(key)) continue
    const display = formatUnknown(value)
    if (display == null) continue
    push('MORE', { key: humanizeKey(key), value: display })
  }

  return sectionOrder
    .map((section) => ({ label: section, rows: rowsBySection.get(section)! }))
    .filter((g) => g.rows.length > 0)
}

export function buildCompanyGroups(detail: LedgerDetail): LedgerGroup[] {
  return build(detail, COMPANY_FIELD_REGISTRY, COMPANY_FIELD_SKIP_SET)
}

export function buildContactGroups(detail: LedgerDetail): LedgerGroup[] {
  return build(detail, CONTACT_FIELD_REGISTRY, CONTACT_FIELD_SKIP_SET)
}
