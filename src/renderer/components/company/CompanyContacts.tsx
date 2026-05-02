import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyContactRef } from '../../../shared/types/company'
import type { ContactSummary } from '../../../shared/types/contact'
import { ContactAvatar } from '../crm/ContactAvatar'
import { EntityPicker } from '../common/EntityPicker'
import { usePicker } from '../../hooks/usePicker'
import styles from './CompanyContacts.module.css'
import { api } from '../../api'

interface CompanyContactsProps {
  companyId: string
  className?: string
}

export function CompanyContacts({ companyId, className }: CompanyContactsProps) {
  const [contacts, setContacts] = useState<CompanyContactRef[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const creatingRef = useRef(false)
  const navigate = useNavigate()
  const contactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST, 8)

  function load() {
    window.api
      .invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId)
      .then((data) => setContacts(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }

  useEffect(() => { setLoaded(false) }, [companyId])

  useEffect(() => {
    if (!loaded) load()
  }, [companyId, loaded])

  async function handleLinkContact(contactId: string) {
    await api.invoke(IPC_CHANNELS.COMPANY_LINK_CONTACT, companyId, contactId)
    setLoaded(false)
  }

  const handleCreateContact = useCallback(async (name: string) => {
    if (creatingRef.current) return
    creatingRef.current = true
    try {
      const contact = await api.invoke<ContactSummary>(
        IPC_CHANNELS.CONTACT_CREATE,
        { fullName: name.trim() }
      )
      if (contact) {
        await handleLinkContact(contact.id)
        setShowPicker(false)
      }
    } catch (err) {
      console.error('[CompanyContacts] Failed to create contact:', err)
    } finally {
      creatingRef.current = false
    }
  }, [companyId])

  async function handleUnlinkContact(e: React.MouseEvent, contactId: string) {
    e.stopPropagation()
    await api.invoke(IPC_CHANNELS.COMPANY_UNLINK_CONTACT, companyId, contactId)
    setLoaded(false)
  }

  async function handleSetPrimary(e: React.MouseEvent, contactId: string) {
    e.stopPropagation()
    await api.invoke(IPC_CHANNELS.COMPANY_SET_PRIMARY_CONTACT, companyId, contactId)
    setLoaded(false)
  }

  async function handleClearPrimary(e: React.MouseEvent, contactId: string) {
    e.stopPropagation()
    await api.invoke(IPC_CHANNELS.COMPANY_CLEAR_PRIMARY_CONTACT, companyId, contactId)
    setLoaded(false)
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.searchRow}>
        {showPicker ? (
          <EntityPicker<ContactSummary>
            picker={contactPicker}
            placeholder="Search contacts…"
            renderItem={(c) => (
              <>
                {c.fullName}
                {c.primaryCompanyName && (
                  <span className={styles.pickerSub}> — {c.primaryCompanyName}</span>
                )}
              </>
            )}
            onSelect={(c) => { void handleLinkContact(c.id); setShowPicker(false) }}
            onClose={() => setShowPicker(false)}
            onCreate={handleCreateContact}
          />
        ) : (
          <button className={styles.addBtn} onClick={() => setShowPicker(true)}>
            + Link a contact
          </button>
        )}
      </div>
      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && contacts.length === 0 && (
        <div className={styles.empty}>No contacts linked yet.</div>
      )}
      {contacts.map((contact) => (
        <div
          key={contact.id}
          className={styles.contact}
          onClick={() => navigate(`/contact/${contact.id}`)}
        >
          <ContactAvatar name={contact.fullName} size="md" />
          <div className={styles.info}>
            <div className={styles.name}>
              {contact.fullName}
              {contact.isPrimary && <span className={styles.primary}>primary</span>}
              {contact.isPastEmployee && <span className={styles.pastEmployee}>past</span>}
            </div>
            {contact.title && <div className={styles.title}>{contact.title}</div>}
            {contact.email && <div className={styles.email}>{contact.email}</div>}
          </div>
          <div className={styles.meta}>
            {contact.meetingCount > 0 && (
              <span className={styles.badge}>{contact.meetingCount} mtg</span>
            )}
            {contact.isPrimary ? (
              <button
                className={styles.primaryBtn}
                onClick={(e) => handleClearPrimary(e, contact.id)}
                title="Remove primary"
              >
                Remove primary
              </button>
            ) : (
              <button
                className={styles.primaryBtn}
                onClick={(e) => handleSetPrimary(e, contact.id)}
                title="Make primary"
              >
                Make primary
              </button>
            )}
            <button
              className={styles.removeBtn}
              onClick={(e) => handleUnlinkContact(e, contact.id)}
              title="Remove contact"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
