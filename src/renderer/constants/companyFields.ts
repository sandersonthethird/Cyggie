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
  { key: 'industry',            label: 'Industry',          defaultSection: 'overview'    },
  { key: 'targetCustomer',      label: 'Target Customer',   defaultSection: 'overview'    },
  { key: 'businessModel',       label: 'Business Model',    defaultSection: 'overview'    },
  { key: 'productStage',        label: 'Product Stage',     defaultSection: 'overview'    },
  { key: 'foundingYear',        label: 'Founded',           defaultSection: 'overview'    },
  { key: 'employeeCountRange',  label: 'Employees',         defaultSection: 'overview'    },
  { key: 'hqAddress',           label: 'HQ',                defaultSection: 'overview'    },
  { key: 'revenueModel',        label: 'Revenue Model',     defaultSection: 'overview'    },
  // Pipeline
  { key: 'sourceType',          label: 'Source Type',       defaultSection: 'pipeline'    },
  { key: 'sourceEntityId',      label: 'Source Name',       defaultSection: 'pipeline'    },
  { key: 'dealSource',          label: 'Deal Source',       defaultSection: 'pipeline'    },
  { key: 'warmIntroSource',     label: 'Warm Intro Source', defaultSection: 'pipeline'    },
  { key: 'referralContactId',   label: 'Referral Contact',  defaultSection: 'pipeline'    },
  { key: 'relationshipOwner',   label: 'Relationship Owner',defaultSection: 'pipeline'    },
  { key: 'nextFollowupDate',    label: 'Next Follow-up',    defaultSection: 'pipeline'    },
  // Financials
  { key: 'round',               label: 'Last Round',        defaultSection: 'financials'  },
  { key: 'raiseSize',           label: 'Raise Size',        defaultSection: 'financials'  },
  { key: 'postMoneyValuation',  label: 'Initial Valuation',  defaultSection: 'financials'  },
  { key: 'arr',                 label: 'ARR',               defaultSection: 'financials'  },
  { key: 'burnRate',            label: 'Burn Rate',         defaultSection: 'financials'  },
  { key: 'runwayMonths',        label: 'Runway (months)',   defaultSection: 'financials'  },
  { key: 'lastFundingDate',     label: 'Last Funded',       defaultSection: 'financials'  },
  { key: 'totalFundingRaised',  label: 'Total Raised',      defaultSection: 'financials'  },
  { key: 'leadInvestor',        label: 'Lead Investor',     defaultSection: 'financials'  },
  { key: 'coInvestors',         label: 'Co-Investors',      defaultSection: 'financials'  },
  { key: 'priorInvestors',      label: 'Prior Investors',   defaultSection: 'financials'  },
  { key: 'subsequentInvestors', label: 'Subsequent Investors', defaultSection: 'financials' },
  // Investment
  { key: 'portfolioFund',       label: 'Portfolio',         defaultSection: 'investment'  },
  { key: 'status',              label: 'Status',            defaultSection: 'investment'  },
  { key: 'investmentSize',      label: 'Initial Investment', defaultSection: 'investment' },
  { key: 'ownershipPct',        label: 'Initial Ownership %', defaultSection: 'investment' },
  { key: 'investmentMark',      label: 'Investment Mark',   defaultSection: 'investment'  },
  { key: 'investmentRound',     label: 'Investment Round',  defaultSection: 'investment'  },
  { key: 'initialInvestmentSecurity', label: 'Initial Security', defaultSection: 'investment' },
  { key: 'dateOfInitialInvestment', label: 'Date of Initial Investment', defaultSection: 'investment' },
  { key: 'initialRoundSize',    label: 'Initial Round Size', defaultSection: 'investment' },
  { key: 'lastCompanyValuation', label: 'Last Company Valuation', defaultSection: 'investment' },
  { key: 'followonCheck',       label: 'Follow-on Check',   defaultSection: 'investment'  },
  { key: 'followonDate',        label: 'Follow-on Date',    defaultSection: 'investment'  },
  { key: 'followonCheck2',      label: 'Follow-on Check 2', defaultSection: 'investment'  },
  { key: 'followonDate2',       label: 'Follow-on Date 2',  defaultSection: 'investment'  },
  { key: 'followonInvestmentSize', label: 'Follow-on Size',  defaultSection: 'investment'  },
  { key: 'totalInvested',       label: 'Total Investment',   defaultSection: 'investment'  },
  // Links
  { key: 'linkedinCompanyUrl',  label: 'LinkedIn',          defaultSection: 'links'       },
  { key: 'crunchbaseUrl',       label: 'Crunchbase',        defaultSection: 'links'       },
  { key: 'angellistUrl',        label: 'AngelList',         defaultSection: 'links'       },
  { key: 'twitterHandle',       label: 'Twitter/X',         defaultSection: 'links'       },
]

/** O(1) lookup by key */
export const COMPANY_HARDCODED_FIELD_MAP = new Map(
  COMPANY_HARDCODED_FIELDS.map((f) => [f.key, f])
)
