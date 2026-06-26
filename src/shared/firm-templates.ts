/**
 * Firm-type templates — seed bundles that give a new firm a coherent starting
 * config (default views, labels, field option lists) without hardcoding any one
 * firm's setup into the product.
 *
 * A template is applied idempotently per user/device by `applyFirmTemplate`
 * (renderer), guarded by a synced `template_applied:<id>` marker. The shipped
 * code stays firm-neutral; the per-firm choice rides `firms.template_id` (NOT
 * yet wired through the gateway — until it is, callers resolve to `vc`).
 *
 *   pick (onboarding) ──▶ firms.template_id ──▶ [token] ──▶ applyFirmTemplate()
 *                                                              │ marker set? skip
 *                                                              ▼
 *                                            seed views + labels + field options
 *
 * NOTE on portfolioFund: its defaults (Fund I…V / Personal) intentionally stay
 * in the shared base `PORTFOLIO_FUND_OPTIONS` (company.ts), NOT in the `vc`
 * template. Seeding them here as option strings would clash with existing rows
 * stored as value codes ('fund_iv') vs labels ('Fund IV'). Moving them out is
 * tracked with the broader per-firm-field work; see company.ts TODO(multi-firm).
 */

export type FirmTemplateId = 'vc' | 'sales'

/** Default saved view seeded into a CRM entity's views store (localStorage).
 *  Mirrors `SavedView` in ViewsBar; kept structural here so shared/ doesn't
 *  depend on renderer code. `urlParams` is normalizeParams() output (sorted). */
export interface TemplateSavedView {
  id: string
  name: string
  urlParams: string
  columns: string[]
}

/** Option strings to add to a builtin select field's options_json (additive,
 *  merged on top of the field's hardcoded base via mergeBuiltinOptions). */
export interface TemplateFieldOptions {
  fieldKey: string
  options: string[]
}

export interface FirmTemplate {
  id: FirmTemplateId
  label: string
  /** Seeded into builtin custom-field defs' options_json (synced). */
  companyFieldOptions: TemplateFieldOptions[]
  /** Column label remaps, applied to the per-device label-override store. */
  companyLabelOverrides: Record<string, string>
  /** Default company saved views. */
  companyViews: TemplateSavedView[]
}

// Re-homed from the former hardcoded effect in Companies.tsx. Red-Swan-shaped
// Fund IV portfolio view. urlParams is normalizeParams() form (keys sorted).
const FUND_IV_VIEW: TemplateSavedView = {
  id: 'fund-iv-default',
  name: 'Fund IV',
  urlParams: 'fund=fund_iv&type=portfolio',
  columns: [
    'name', 'description', 'primaryDomain', 'industry', 'location', 'status',
    'totalInvested', 'investmentMark', 'investmentRound', 'investmentSize',
    'initialInvestmentSecurity', 'dateOfInitialInvestment', 'ownershipPct',
    'initialRoundSize', 'postMoneyValuation', 'lastCompanyValuation', 'round',
    'followonCheck', 'followonDate', 'followonCheck2', 'followonDate2',
    'coInvestorNames', 'subsequentInvestorNames',
  ],
}

const VC_TEMPLATE: FirmTemplate = {
  id: 'vc',
  label: 'Venture / Investor',
  companyFieldOptions: [], // portfolioFund stays in the shared base (see header)
  companyLabelOverrides: {},
  companyViews: [FUND_IV_VIEW],
}

// Stub — proves the registry holds >1 firm type and that a non-VC firm starts
// clean (no Fund IV view, no VC funds). Fleshed out when the picker + gateway
// plumbing lands and a real sales design partner exists.
const SALES_TEMPLATE: FirmTemplate = {
  id: 'sales',
  label: 'Sales',
  companyFieldOptions: [],
  companyLabelOverrides: {},
  companyViews: [],
}

export const FIRM_TEMPLATES: Record<FirmTemplateId, FirmTemplate> = {
  vc: VC_TEMPLATE,
  sales: SALES_TEMPLATE,
}

export const DEFAULT_FIRM_TEMPLATE_ID: FirmTemplateId = 'vc'

/** Resolve a (possibly null / unknown / forged) template id to a template,
 *  falling back to the default. Centralizes the NULL→vc rule. */
export function resolveFirmTemplate(id: string | null | undefined): FirmTemplate {
  if (id && id in FIRM_TEMPLATES) return FIRM_TEMPLATES[id as FirmTemplateId]
  return FIRM_TEMPLATES[DEFAULT_FIRM_TEMPLATE_ID]
}
