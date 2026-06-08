/**
 * Single source of truth for each contact hardcoded field's editor `type` and
 * `options` — the contact counterpart of companyFieldMeta. Consumed by the Add
 * Field modal's `getFieldEditor` (ContactPropertiesPanel) and by the section
 * rows in ContactFieldSections.
 *
 * Note: the contact-info "header" fields (phone, linkedinUrl, address parts)
 * live in ContactHeaderCard, not ContactFieldSections, so only the modal reads
 * their meta here. They're plain text/url, so there's no real drift surface.
 *
 * `complex` fields (previousCompanies inline editor, investmentSectorFocus
 * TagPicker) are handled directly in getFieldEditor.
 */
import type { PropertyRowType, PropertyRowOption } from '../components/crm/PropertyRow'

export interface ContactOptionCtx {
  talentPipeline: PropertyRowOption[]
}

export interface ContactFieldMeta {
  type: PropertyRowType
  getOptions?: (ctx: ContactOptionCtx) => PropertyRowOption[]
  coerceNull?: true
  complex?: true
}

const DASH = { value: '', label: '—' }

export const CONTACT_FIELD_META: Record<string, ContactFieldMeta> = {
  // ── Contact Info (header fields rendered by ContactHeaderCard) ──
  phone: { type: 'text' },
  linkedinUrl: { type: 'url' },
  street: { type: 'text' },
  city: { type: 'text' },
  state: { type: 'text' },
  postalCode: { type: 'text' },
  country: { type: 'text' },
  // ── Contact Info (section fields) ──
  twitterHandle: { type: 'text' },
  timezone: { type: 'text' },
  // ── Professional ──
  previousCompanies: { type: 'text', complex: true },
  university: { type: 'text' },
  tags: { type: 'tags' },
  pronouns: { type: 'text' },
  // ── Relationship ──
  talentPipeline: { type: 'select', getOptions: (c) => [DASH, ...c.talentPipeline], coerceNull: true },
  lastMetEvent: { type: 'text' },
  warmIntroPath: { type: 'textarea' },
  notes: { type: 'textarea' },
  // ── Investor Info ──
  fundSize: { type: 'currency' },
  typicalCheckSizeMin: { type: 'currency' },
  typicalCheckSizeMax: { type: 'currency' },
  investmentStageFocus: { type: 'multiselect', complex: true },
  investmentSectorFocus: { type: 'multiselect', complex: true },
  investmentSectorFocusNotes: { type: 'text' },
  proudPortfolioCompanies: { type: 'text' },
}
