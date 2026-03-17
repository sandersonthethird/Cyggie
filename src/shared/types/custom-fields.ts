export const CONTACT_SECTIONS: { key: string; label: string }[] = [
  { key: 'contact_info',  label: 'Contact Info' },
  { key: 'professional',  label: 'Professional' },
  { key: 'relationship',  label: 'Relationship' },
  { key: 'investor_info', label: 'Investor Info' },
]

export const COMPANY_SECTIONS: { key: string; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'pipeline',   label: 'Pipeline' },
  { key: 'financials', label: 'Financials' },
  { key: 'investment', label: 'Investment' },
  { key: 'links',      label: 'Links' },
]

export type CustomFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'date'
  | 'url'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'contact_ref'
  | 'company_ref'

export type CustomFieldEntityType = 'company' | 'contact'

export interface CustomFieldDefinition {
  id: string
  entityType: CustomFieldEntityType
  fieldKey: string
  label: string
  fieldType: CustomFieldType
  optionsJson: string | null
  isRequired: boolean
  sortOrder: number
  showInList: boolean
  isBuiltin: boolean
  section: string | null
  createdAt: string
  updatedAt: string
}

export interface CustomFieldValue {
  id: string
  fieldDefinitionId: string
  entityType: CustomFieldEntityType
  entityId: string
  valueText: string | null
  valueNumber: number | null
  valueBoolean: boolean | null
  valueDate: string | null
  valueRefId: string | null
  resolvedLabel: string | null
  createdAt: string
  updatedAt: string
}

export interface CustomFieldWithValue extends CustomFieldDefinition {
  value: CustomFieldValue | null
}

export interface CreateCustomFieldDefinitionInput {
  entityType: CustomFieldEntityType
  fieldKey?: string
  label: string
  fieldType: CustomFieldType
  optionsJson?: string | null
  isRequired?: boolean
  sortOrder?: number
  showInList?: boolean
  section?: string | null
}

export interface UpdateCustomFieldDefinitionInput {
  label?: string
  fieldType?: CustomFieldType
  optionsJson?: string | null
  isRequired?: boolean
  sortOrder?: number
  showInList?: boolean
  section?: string | null
}

export interface SetCustomFieldValueInput {
  fieldDefinitionId: string
  entityId: string
  entityType: CustomFieldEntityType
  valueText?: string | null
  valueNumber?: number | null
  valueBoolean?: boolean | null
  valueDate?: string | null
  valueRefId?: string | null
}
