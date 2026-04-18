export interface HardcodedFieldDef {
  key: string
  label: string
  defaultSection: string
}

/**
 * All hideable hardcoded fields for contacts, in their default section order.
 * Powers the Add Field picker (not section rendering — panels keep hardcoded blocks).
 *
 * NOTE: Only includes PropertyRow-based fields that can be hidden/shown via showField().
 * Always-visible special renders (emails, otherSocials, relationshipStrength) are excluded.
 *
 * NOTE: When adding a new hardcoded field to ContactPropertiesPanel, add it here too.
 */
export const CONTACT_HARDCODED_FIELDS: HardcodedFieldDef[] = [
  // Contact Info
  { key: 'phone',               label: 'Phone',            defaultSection: 'contact_info'  },
  { key: 'linkedinUrl',         label: 'LinkedIn',         defaultSection: 'contact_info'  },
  { key: 'twitterHandle',       label: 'Twitter/X',        defaultSection: 'contact_info'  },
  { key: 'city',                label: 'City',             defaultSection: 'contact_info'  },
  { key: 'state',               label: 'State',            defaultSection: 'contact_info'  },
  { key: 'timezone',            label: 'Timezone',         defaultSection: 'contact_info'  },
  // Professional
  { key: 'previousCompanies',   label: 'Prior Company',    defaultSection: 'professional'  },
  { key: 'university',          label: 'University',       defaultSection: 'professional'  },
  { key: 'tags',                label: 'Tags',             defaultSection: 'professional'  },
  { key: 'pronouns',            label: 'Pronouns',         defaultSection: 'professional'  },
  // Relationship
  { key: 'talentPipeline',      label: 'Talent Pipeline',  defaultSection: 'relationship'  },
  { key: 'lastMetEvent',        label: 'Last Met At',      defaultSection: 'relationship'  },
  { key: 'warmIntroPath',       label: 'Warm Intro Path',  defaultSection: 'relationship'  },
  { key: 'notes',               label: 'Notes',            defaultSection: 'relationship'  },
  // Investor Info
  { key: 'fundSize',            label: 'Fund Size',        defaultSection: 'investor_info' },
  { key: 'typicalCheckSizeMin', label: 'Check Size Min',   defaultSection: 'investor_info' },
  { key: 'typicalCheckSizeMax', label: 'Check Size Max',   defaultSection: 'investor_info' },
  { key: 'investmentStageFocus',label: 'Stage Focus',      defaultSection: 'investor_info' },
  { key: 'investmentSectorFocus',label:'Sector Focus',     defaultSection: 'investor_info' },
  { key: 'investorStage',       label: 'Investor Stage',   defaultSection: 'investor_info' },
  { key: 'proudPortfolioCompanies', label: 'Portfolio Cos', defaultSection: 'investor_info' },
]

/** O(1) lookup by key */
export const CONTACT_HARDCODED_FIELD_MAP = new Map(
  CONTACT_HARDCODED_FIELDS.map((f) => [f.key, f])
)
