import { describe, expect, test } from 'vitest'
import { COMPANY_HARDCODED_FIELDS } from '../renderer/constants/companyFields'
import { CONTACT_HARDCODED_FIELDS } from '../renderer/constants/contactFields'
import { COMPANY_FIELD_META } from '../renderer/constants/companyFieldMeta'
import { CONTACT_FIELD_META } from '../renderer/constants/contactFieldMeta'

// Guards the single source of truth: every hardcoded field the Add Field modal
// can list must have editor metadata, so a newly-added field can't silently
// miss the registry (and end up with no inline editor / wrong type).

describe('field-meta registry drift', () => {
  test('every company hardcoded field has metadata', () => {
    const missing = COMPANY_HARDCODED_FIELDS.filter((f) => !(f.key in COMPANY_FIELD_META))
    expect(missing.map((f) => f.key)).toEqual([])
  })

  test('every contact hardcoded field has metadata', () => {
    const missing = CONTACT_HARDCODED_FIELDS.filter((f) => !(f.key in CONTACT_FIELD_META))
    expect(missing.map((f) => f.key)).toEqual([])
  })
})
