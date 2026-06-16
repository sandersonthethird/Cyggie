import type { HardcodedFieldDef } from './contactFields'

export type { HardcodedFieldDef }

/**
 * All hideable hardcoded fields for companies, in their default section order.
 * Powers the Add Field picker (not section rendering — panels keep hardcoded blocks).
 *
 * NOTE: Only includes fields rendered via show() + HideableRow. pipelineStage and
 * priority are header-chip-only fields (not in sections) so they are excluded here.
 *
 * NOTE: When adding a new hardcoded field to CompanyPropertiesPanel, add it here too.
 */
export const COMPANY_HARDCODED_FIELDS: HardcodedFieldDef[] = [
  // Overview
  { key: 'industry',            label: 'Industry',          defaultSection: 'overview',    icon: 'tag' },
  { key: 'targetCustomer',      label: 'Target Customer',   defaultSection: 'overview',    icon: 'tag' },
  { key: 'businessModel',       label: 'Business Model',    defaultSection: 'overview',    icon: 'tag' },
  { key: 'productStage',        label: 'Product Stage',     defaultSection: 'overview',    icon: 'tag' },
  { key: 'targetInvestmentStage',  label: 'Target Investment Stage',  defaultSection: 'overview', icon: 'flag' },
  { key: 'targetInvestmentSector', label: 'Target Investment Sector', defaultSection: 'overview', icon: 'tag' },
  { key: 'foundingYear',        label: 'Founded',           defaultSection: 'overview',    icon: 'calendar' },
  { key: 'employeeCountRange',  label: 'Employees',         defaultSection: 'overview',    icon: 'user' },
  { key: 'revenueModel',        label: 'Revenue Model',     defaultSection: 'overview',    icon: 'tag' },
  // Pipeline
  { key: 'sourceType',          label: 'Source Type',       defaultSection: 'pipeline',    icon: 'tag' },
  { key: 'sourceEntityId',      label: 'Source Name',       defaultSection: 'pipeline',    icon: 'user' },
  { key: 'dealSource',          label: 'Deal Source',       defaultSection: 'pipeline',    icon: 'tag' },
  { key: 'warmIntroSource',     label: 'Warm Intro Source', defaultSection: 'pipeline',    icon: 'handshake' },
  { key: 'referralContactId',   label: 'Referral Contact',  defaultSection: 'pipeline',    icon: 'user' },
  { key: 'relationshipOwner',   label: 'Relationship Owner',defaultSection: 'pipeline',    icon: 'user' },
  { key: 'nextFollowupDate',    label: 'Next Follow-up',    defaultSection: 'pipeline',    icon: 'calendar' },
  // Financials
  { key: 'round',               label: 'Last Round',        defaultSection: 'financials',  icon: 'tag' },
  { key: 'raiseSize',           label: 'Raise Size',        defaultSection: 'financials',  icon: 'money' },
  { key: 'postMoneyValuation',  label: 'Initial Valuation', defaultSection: 'financials',  icon: 'money' },
  { key: 'arr',                 label: 'ARR',               defaultSection: 'financials',  icon: 'money' },
  { key: 'burnRate',            label: 'Burn Rate',         defaultSection: 'financials',  icon: 'money' },
  { key: 'runwayMonths',        label: 'Runway (months)',   defaultSection: 'financials' },
  { key: 'lastFundingDate',     label: 'Last Funded',       defaultSection: 'financials',  icon: 'calendar' },
  { key: 'totalFundingRaised',  label: 'Total Raised',      defaultSection: 'financials',  icon: 'money' },
  { key: 'leadInvestor',        label: 'Lead Investor',     defaultSection: 'financials',  icon: 'user' },
  { key: 'coInvestors',         label: 'Co-Investors',      defaultSection: 'financials',  icon: 'handshake' },
  { key: 'priorInvestors',      label: 'Prior Investors',   defaultSection: 'financials',  icon: 'handshake' },
  { key: 'subsequentInvestors', label: 'Subsequent Investors', defaultSection: 'financials', icon: 'handshake' },
  // Investment
  { key: 'portfolioFund',       label: 'Portfolio',         defaultSection: 'investment',  icon: 'tag' },
  { key: 'status',              label: 'Status',            defaultSection: 'investment',  icon: 'flag' },
  { key: 'investmentSize',      label: 'Initial Investment', defaultSection: 'investment', icon: 'money' },
  { key: 'ownershipPct',        label: 'Initial Ownership %', defaultSection: 'investment' },
  { key: 'investmentMark',      label: 'Investment Mark',   defaultSection: 'investment',  icon: 'money' },
  { key: 'investmentRound',     label: 'Investment Round',  defaultSection: 'investment',  icon: 'tag' },
  { key: 'initialInvestmentSecurity', label: 'Initial Security', defaultSection: 'investment', icon: 'tag' },
  { key: 'dateOfInitialInvestment', label: 'Date of Initial Investment', defaultSection: 'investment', icon: 'calendar' },
  { key: 'initialRoundSize',    label: 'Initial Round Size', defaultSection: 'investment', icon: 'money' },
  { key: 'lastCompanyValuation', label: 'Last Company Valuation', defaultSection: 'investment', icon: 'money' },
  { key: 'followonCheck',       label: 'Follow-on Check',   defaultSection: 'investment',  icon: 'money' },
  { key: 'followonDate',        label: 'Follow-on Date',    defaultSection: 'investment',  icon: 'calendar' },
  { key: 'followonCheck2',      label: 'Follow-on Check 2', defaultSection: 'investment',  icon: 'money' },
  { key: 'followonDate2',       label: 'Follow-on Date 2',  defaultSection: 'investment',  icon: 'calendar' },
  { key: 'followonInvestmentSize', label: 'Follow-on Size',  defaultSection: 'investment', icon: 'money' },
  { key: 'totalInvested',       label: 'Total Investment',   defaultSection: 'investment', icon: 'money' },
  // Links
  { key: 'linkedinCompanyUrl',  label: 'LinkedIn',          defaultSection: 'links',       icon: 'link' },
  { key: 'crunchbaseUrl',       label: 'Crunchbase',        defaultSection: 'links',       icon: 'link' },
  { key: 'angellistUrl',        label: 'AngelList',         defaultSection: 'links',       icon: 'link' },
  { key: 'twitterHandle',       label: 'Twitter/X',         defaultSection: 'links',       icon: 'link' },
]

/** O(1) lookup by key */
export const COMPANY_HARDCODED_FIELD_MAP = new Map(
  COMPANY_HARDCODED_FIELDS.map((f) => [f.key, f])
)
