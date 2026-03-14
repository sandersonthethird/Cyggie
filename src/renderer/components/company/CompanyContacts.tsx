import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyContactRef } from '../../../shared/types/company'
import { ContactAvatar } from '../crm/ContactAvatar'
import { EntitySearch } from '../crm/EntitySearch'
import styles from './CompanyContacts.module.css'

interface CompanyContactsProps {
  companyId: string
  className?: string
}

export function CompanyContacts({ companyId, className }: CompanyContactsProps) {
  const [contacts, setContacts] = useState<CompanyContactRef[]>([])
  const [loaded, setLoaded] = useState(false)
  const navigate = useNavigate()

  function load() {
    window.api
      .invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId)
      .then((data) => setContacts(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }

  useEffect(() => {
    if (!loaded) load()
  }, [companyId, loaded])

  async function handleLinkContact(contactId: string) {
    await window.api.invoke(IPC_CHANNELS.COMPANY_LINK_CONTACT, companyId, contactId)
    setLoaded(false)
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.searchRow}>
        <EntitySearch
          entityType="contact"
          onSelect={(id) => handleLinkContact(id)}
          placeholder="Link a contact…"
        />
      </div>
      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && contacts.length === 0 && (
        <div className={styles.empty}>No contacts linked yet.</div>
      )}
      {contacts.map((contact) => (
        <div
          key={contact.id}
          className={styles.contact}
          onClick={() => navigate(`/contacts/${contact.id}`)}
        >
          <ContactAvatar name={contact.fullName} size="md" />
          <div className={styles.info}>
            <div className={styles.name}>
              {contact.fullName}
              {contact.isPrimary && <span className={styles.primary}>primary</span>}
            </div>
            {contact.title && <div className={styles.title}>{contact.title}</div>}
            {contact.email && <div className={styles.email}>{contact.email}</div>}
          </div>
          <div className={styles.meta}>
            {contact.meetingCount > 0 && (
              <span className={styles.badge}>{contact.meetingCount} mtg</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
