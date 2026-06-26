/**
 * Single source of truth for each company hardcoded field's editor `type` and
 * `options`. Consumed by BOTH:
 *   - CompanyFieldSections (the detail-page rows), via `type={M.key.type}
 *     options={M.key.getOptions?.(ctx)}`, and
 *   - the Add Field modal's `getFieldEditor` (CompanyPropertiesPanel), so the
 *     inline value editor renders the right control.
 *
 * Keeping it in one place is what stops the two consumers from drifting (eng
 * review issue 2B). A drift test asserts every COMPANY_HARDCODED_FIELDS key is
 * either present here or flagged `complex`.
 *
 * `complex` fields (investor pickers, source-name) are NOT plain PropertyRows —
 * they're rendered/edited by bespoke components and handled directly in
 * getFieldEditor, so they carry no `type` here.
 */
import type { PropertyRowType, PropertyRowOption } from '../components/crm/PropertyRow'
import {
  INVESTMENT_SECURITY_OPTIONS,
  STATUS_OPTIONS,
} from '../../shared/types/company'

/** The runtime-resolved option bundle the panel already computes and passes to
 *  CompanyFieldSections as its `options` prop. Mirrors that OptionSet shape. */
export interface CompanyOptionCtx {
  industry: PropertyRowOption[]
  targetCustomer: PropertyRowOption[]
  businessModel: PropertyRowOption[]
  productStage: PropertyRowOption[]
  employeeRange: PropertyRowOption[]
  round: PropertyRowOption[]
  portfolioFund: PropertyRowOption[]
  targetInvestmentStage: PropertyRowOption[]
  targetInvestmentSector: PropertyRowOption[]
}

export interface CompanyFieldMeta {
  type: PropertyRowType
  getOptions?: (ctx: CompanyOptionCtx) => PropertyRowOption[]
  /** save(key, v) should coerce '' → null (matches the section's onSave). */
  coerceNull?: true
  /** bespoke editor (MultiCompanyPicker / SourceNameField) — not a PropertyRow. */
  complex?: true
}

const DASH = { value: '', label: '—' }

const SOURCE_TYPE_OPTIONS: PropertyRowOption[] = [
  DASH,
  { value: 'personal relationship', label: 'Personal Relationship' },
  { value: 'emerging manager', label: 'Emerging Manager' },
  { value: 'founder', label: 'Founder' },
  { value: 'incubator', label: 'Incubator' },
  { value: 'accelerator', label: 'Accelerator' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'later stage VC', label: 'Later Stage VC' },
  { value: 'LP', label: 'LP' },
  { value: 'outbound', label: 'Outbound' },
]

export const COMPANY_FIELD_META: Record<string, CompanyFieldMeta> = {
  // ── Overview ──
  industry: { type: 'select', getOptions: (c) => c.industry },
  targetCustomer: { type: 'select', getOptions: (c) => c.targetCustomer },
  businessModel: { type: 'select', getOptions: (c) => c.businessModel },
  productStage: { type: 'select', getOptions: (c) => c.productStage },
  targetInvestmentStage: { type: 'multiselect', getOptions: (c) => c.targetInvestmentStage },
  targetInvestmentSector: { type: 'multiselect', getOptions: (c) => c.targetInvestmentSector },
  foundingYear: { type: 'number' },
  employeeCountRange: { type: 'select', getOptions: (c) => c.employeeRange },
  hqAddress: { type: 'text' },
  revenueModel: { type: 'text' },
  // ── Pipeline ──
  sourceType: { type: 'select', getOptions: () => SOURCE_TYPE_OPTIONS, coerceNull: true },
  sourceEntityId: { type: 'text', complex: true },
  dealSource: { type: 'text' },
  warmIntroSource: { type: 'text' },
  referralContactId: { type: 'contact_ref' },
  relationshipOwner: { type: 'text' },
  nextFollowupDate: { type: 'date' },
  // ── Financials ──
  round: { type: 'select', getOptions: (c) => [DASH, ...c.round] },
  raiseSize: { type: 'currency' },
  postMoneyValuation: { type: 'currency' },
  arr: { type: 'currency' },
  burnRate: { type: 'currency' },
  runwayMonths: { type: 'number' },
  lastFundingDate: { type: 'date' },
  totalFundingRaised: { type: 'currency' },
  leadInvestor: { type: 'text', complex: true },
  coInvestors: { type: 'text', complex: true },
  priorInvestors: { type: 'text', complex: true },
  subsequentInvestors: { type: 'text', complex: true },
  // ── Investment ──
  portfolioFund: { type: 'select', getOptions: (c) => [DASH, ...c.portfolioFund] },
  status: { type: 'select', getOptions: () => STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
  investmentSize: { type: 'text' },
  ownershipPct: { type: 'text' },
  investmentMark: { type: 'number' },
  investmentRound: { type: 'select', getOptions: (c) => [DASH, ...c.round] },
  initialInvestmentSecurity: { type: 'select', getOptions: () => [DASH, ...INVESTMENT_SECURITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))] },
  dateOfInitialInvestment: { type: 'date' },
  initialRoundSize: { type: 'number' },
  lastCompanyValuation: { type: 'number' },
  followonCheck: { type: 'number' },
  followonDate: { type: 'date' },
  followonCheck2: { type: 'number' },
  followonDate2: { type: 'date' },
  followonInvestmentSize: { type: 'text' },
  totalInvested: { type: 'text' },
  // ── Links ──
  linkedinCompanyUrl: { type: 'url' },
  crunchbaseUrl: { type: 'url' },
  angellistUrl: { type: 'url' },
  twitterHandle: { type: 'text' },
}
