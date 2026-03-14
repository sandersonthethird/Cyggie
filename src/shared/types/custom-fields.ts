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
  fieldKey: string
  label: string
  fieldType: CustomFieldType
  optionsJson?: string | null
  isRequired?: boolean
  sortOrder?: number
  showInList?: boolean
}

export interface UpdateCustomFieldDefinitionInput {
  label?: string
  fieldType?: CustomFieldType
  optionsJson?: string | null
  isRequired?: boolean
  sortOrder?: number
  showInList?: boolean
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
