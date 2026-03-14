import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ContactDetail as ContactDetailType } from '../../shared/types/contact'
import { ContactPropertiesPanel } from '../components/contact/ContactPropertiesPanel'
import { ContactMeetings } from '../components/contact/ContactMeetings'
import { ContactEmails } from '../components/contact/ContactEmails'
import { ContactNotes } from '../components/contact/ContactNotes'
import { usePanelResize } from '../hooks/usePanelResize'
import styles from './ContactDetail.module.css'

type ContactTab = 'meetings' | 'emails' | 'notes'

export default function ContactDetail() {
  const { contactId: id } = useParams<{ contactId: string }>()
  const [contact, setContact] = useState<ContactDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<ContactTab>('meetings')
  const { leftWidth, dividerProps } = usePanelResize()

  useEffect(() => {
    if (!id) return
    setLoading(true)
    window.api
      .invoke<ContactDetailType>(IPC_CHANNELS.CONTACT_GET, id)
      .then((data) => setContact(data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id])

  function handleUpdate(updates: Record<string, unknown>) {
    setContact((prev) => prev ? { ...prev, ...updates } : prev)
  }

  if (loading) {
    return <div className={styles.loading}>Loading…</div>
  }
  if (!contact) {
    return <div className={styles.notFound}>Contact not found.</div>
  }

  const tabs: Array<{ key: ContactTab; label: string; badge?: number }> = [
    { key: 'meetings', label: 'Meetings', badge: contact.meetingCount || undefined },
    { key: 'emails', label: 'Emails', badge: contact.emailCount || undefined },
    { key: 'notes', label: 'Notes', badge: contact.noteCount || undefined }
  ]

  return (
    <div className={styles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr` }}>
      {/* Left panel — properties */}
      <div className={styles.leftPanel}>
        <ContactPropertiesPanel contact={contact} onUpdate={handleUpdate} />
      </div>

      {/* Resizable divider */}
      <div className={styles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={styles.rightPanel}>
        <div className={styles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={styles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          <ContactMeetings
            meetings={contact.meetings}
            className={activeTab !== 'meetings' ? styles.hidden : ''}
          />
          <ContactEmails
            contactId={contact.id}
            className={activeTab !== 'emails' ? styles.hidden : ''}
          />
          <ContactNotes
            contactId={contact.id}
            className={activeTab !== 'notes' ? styles.hidden : ''}
          />
        </div>
      </div>
    </div>
  )
}
