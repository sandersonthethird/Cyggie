import type { IconKey } from '../components/common/Icon'

export interface HardcodedFieldDef {
  key: string
  label: string
  defaultSection: string
  icon?: IconKey
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
  { key: 'phone',               label: 'Phone',            defaultSection: 'contact_info', icon: 'phone' },
  { key: 'linkedinUrl',         label: 'LinkedIn',         defaultSection: 'contact_info', icon: 'link' },
  { key: 'twitterHandle',       label: 'Twitter/X',        defaultSection: 'contact_info', icon: 'link' },
  { key: 'street',              label: 'Street',           defaultSection: 'contact_info', icon: 'pin' },
  { key: 'city',                label: 'City',             defaultSection: 'contact_info', icon: 'pin' },
  { key: 'state',               label: 'State',            defaultSection: 'contact_info', icon: 'pin' },
  { key: 'postalCode',          label: 'Postal Code',      defaultSection: 'contact_info', icon: 'pin' },
  { key: 'country',             label: 'Country',          defaultSection: 'contact_info', icon: 'pin' },
  { key: 'timezone',            label: 'Timezone',         defaultSection: 'contact_info', icon: 'pin' },
  // Professional
  { key: 'previousCompanies',   label: 'Prior Company',    defaultSection: 'professional', icon: 'briefcase' },
  { key: 'university',          label: 'University',       defaultSection: 'professional', icon: 'cap' },
  { key: 'tags',                label: 'Tags',             defaultSection: 'professional', icon: 'tag' },
  { key: 'pronouns',            label: 'Pronouns',         defaultSection: 'professional', icon: 'user' },
  // Relationship
  { key: 'talentPipeline',      label: 'Talent Pipeline',  defaultSection: 'relationship', icon: 'flag' },
  { key: 'lastMetEvent',        label: 'Last Met At',      defaultSection: 'relationship', icon: 'calendar' },
  { key: 'warmIntroPath',       label: 'Warm Intro Path',  defaultSection: 'relationship', icon: 'handshake' },
  { key: 'notes',               label: 'Notes',            defaultSection: 'relationship' },
  // Investor Info
  { key: 'fundSize',            label: 'Fund Size',        defaultSection: 'investor_info', icon: 'money' },
  { key: 'typicalCheckSizeMin', label: 'Check Size Min',   defaultSection: 'investor_info', icon: 'money' },
  { key: 'typicalCheckSizeMax', label: 'Check Size Max',   defaultSection: 'investor_info', icon: 'money' },
  { key: 'investmentStageFocus',label: 'Target Investment Stage',  defaultSection: 'investor_info', icon: 'flag' },
  { key: 'investmentSectorFocus',label:'Target Investment Sector', defaultSection: 'investor_info', icon: 'tag' },
  { key: 'investmentSectorFocusNotes', label: 'Target Investment Sector Notes', defaultSection: 'investor_info', icon: 'tag' },
  { key: 'proudPortfolioCompanies', label: 'Portfolio Cos', defaultSection: 'investor_info', icon: 'briefcase' },
]

/** O(1) lookup by key */
export const CONTACT_HARDCODED_FIELD_MAP = new Map(
  CONTACT_HARDCODED_FIELDS.map((f) => [f.key, f])
)
