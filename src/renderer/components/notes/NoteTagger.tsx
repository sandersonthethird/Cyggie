import { useCallback, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { usePicker } from '../../hooks/usePicker'
import { EntityPicker } from '../common/EntityPicker'
import { api } from '../../api'
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

  // Double-click guard: ref for synchronous re-entrancy check, state drives UI.
  const creatingCompanyRef = useRef(false)
  const [creatingCompany, setCreatingCompany] = useState(false)
  const creatingContactRef = useRef(false)
  const [creatingContact, setCreatingContact] = useState(false)

  const companyPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  // Pass companyId so that, when a company is already tagged, its contacts surface first.
  const contactPicker = usePicker<ContactSummary>(
    IPC_CHANNELS.CONTACT_LIST,
    undefined,
    companyId ? { companyId } : undefined
  )

  const handleSelectCompany = useCallback(
    (company: CompanySummary) => {
      onTagCompany(company.id, company.canonicalName)
      setActivePicker(null)
    },
    [onTagCompany]
  )

  const handleCreateCompany = useCallback(
    async (name: string) => {
      if (creatingCompanyRef.current) return
      creatingCompanyRef.current = true
      setCreatingCompany(true)
      try {
        const company = await api.invoke<CompanySummary>(IPC_CHANNELS.COMPANY_FIND_OR_CREATE, name.trim())
        if (company) {
          onTagCompany(company.id, company.canonicalName)
          setActivePicker(null)
        }
      } catch (err) {
        console.error('[NoteTagger] Failed to create company:', err)
      } finally {
        creatingCompanyRef.current = false
        setCreatingCompany(false)
      }
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

  const handleCreateContact = useCallback(
    async (name: string) => {
      if (creatingContactRef.current) return
      creatingContactRef.current = true
      setCreatingContact(true)
      try {
        // createContact handles name splitting (first/last) internally.
        const contact = await api.invoke<ContactSummary>(
          IPC_CHANNELS.CONTACT_CREATE,
          { fullName: name.trim() }
        )
        if (contact) {
          onTagContact(contact.id, contact.fullName)
          setActivePicker(null)
        }
      } catch (err) {
        console.error('[NoteTagger] Failed to create contact:', err)
      } finally {
        creatingContactRef.current = false
        setCreatingContact(false)
      }
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
          onCreate={creatingCompany ? undefined : handleCreateCompany}
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
          onCreate={creatingContact ? undefined : handleCreateContact}
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
