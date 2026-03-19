import { useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { usePicker } from '../../hooks/usePicker'
import { EntityPicker } from '../common/EntityPicker'
import styles from './NoteTagger.module.css'
import type { CompanySummary } from '../../../shared/types/company'
import type { ContactSummary } from '../../../shared/types/contact'

interface NoteTaggerProps {
  companyId: string | null
  companyName: string | null | undefined
  contactId: string | null
  contactName: string | null | undefined
  onTagCompany: (id: string | null, name: string | null) => void
  onTagContact: (id: string | null, name: string | null) => void
}

type PickerType = 'company' | 'contact' | null

export function NoteTagger({
  companyId,
  companyName,
  contactId,
  contactName,
  onTagCompany,
  onTagContact
}: NoteTaggerProps) {
  const [activePicker, setActivePicker] = useState<PickerType>(null)

  const companyPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  const contactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST)

  const handleSelectCompany = useCallback(
    (company: CompanySummary) => {
      onTagCompany(company.id, company.canonicalName)
      setActivePicker(null)
    },
    [onTagCompany]
  )

  const handleSelectContact = useCallback(
    (contact: ContactSummary) => {
      onTagContact(contact.id, contact.fullName)
      setActivePicker(null)
    },
    [onTagContact]
  )

  return (
    <div className={styles.tagger}>
      {/* Company chip or add button */}
      {companyId ? (
        <span className={`${styles.chip} ${styles.company}`}>
          {companyName ?? companyId}
          <button
            className={styles.chipRemove}
            onClick={() => onTagCompany(null, null)}
            title="Remove company tag"
          >
            ×
          </button>
        </span>
      ) : activePicker === 'company' ? (
        <EntityPicker<CompanySummary>
          picker={companyPicker}
          placeholder="Search company…"
          renderItem={(c) => c.canonicalName}
          onSelect={handleSelectCompany}
          onClose={() => setActivePicker(null)}
        />
      ) : (
        <button
          className={styles.addBtn}
          onClick={() => setActivePicker('company')}
        >
          + Company
        </button>
      )}

      {/* Contact chip or add button */}
      {contactId ? (
        <span className={`${styles.chip} ${styles.contact}`}>
          {contactName ?? contactId}
          <button
            className={styles.chipRemove}
            onClick={() => onTagContact(null, null)}
            title="Remove contact tag"
          >
            ×
          </button>
        </span>
      ) : activePicker === 'contact' ? (
        <EntityPicker<ContactSummary>
          picker={contactPicker}
          placeholder="Search contact…"
          renderItem={(c) => (
            <>
              {c.fullName}
              {c.primaryCompanyName && (
                <span className={styles.dropdownItemSub}>{c.primaryCompanyName}</span>
              )}
            </>
          )}
          onSelect={handleSelectContact}
          onClose={() => setActivePicker(null)}
        />
      ) : (
        <button
          className={styles.addBtn}
          onClick={() => setActivePicker('contact')}
        >
          + Contact
        </button>
      )}
    </div>
  )
}
