import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactEmailRef } from '../../../shared/types/contact'
import { useEmailSync } from '../../hooks/useEmailSync'
import { EmailDetailModal } from '../crm/EmailDetailModal'
import styles from './ContactEmails.module.css'

interface ContactEmailsProps {
  contactId: string
  className?: string
}

export function ContactEmails({ contactId, className }: ContactEmailsProps) {
  const [emails, setEmails] = useState<ContactEmailRef[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null)

  const {
    isSyncing,
    syncError,
    syncResult,
    lastSyncedLabel,
    progressMsg,
    handleSync,
    handleCancel
  } = useEmailSync('contact', contactId, () => setLoaded(false))

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<ContactEmailRef[]>(IPC_CHANNELS.CONTACT_EMAILS, contactId)
      .then((data) => setEmails(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [contactId, loaded])

  function getSyncResultMsg() {
    if (!syncResult) return null
    if (syncResult.aborted) {
      return syncResult.insertedMessageCount > 0
        ? `Cancelled — +${syncResult.insertedMessageCount} saved`
        : 'Cancelled'
    }
    return syncResult.insertedMessageCount > 0
      ? `+${syncResult.insertedMessageCount} new`
      : 'Up to date'
  }

  const syncResultMsg = getSyncResultMsg()

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {(loaded || isSyncing) && (
        <div className={styles.syncRow}>
          <span className={styles.lastSynced}>{lastSyncedLabel}</span>
          {progressMsg && isSyncing && (
            <span className={styles.progressMsg}>{progressMsg}</span>
          )}
          <button
            className={styles.syncBtn}
            onClick={handleSync}
            disabled={isSyncing}
            title="Pull emails from Gmail for this contact"
          >
            <span className={isSyncing ? styles.spinning : ''}>↻</span>
            {' '}{isSyncing ? 'Syncing…' : 'Sync emails'}
          </button>
          {isSyncing && (
            <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
          )}
          {syncResultMsg && !isSyncing && (
            <span className={styles.syncMsg}>{syncResultMsg}</span>
          )}
          {syncError && <span className={styles.syncError}>{syncError}</span>}
        </div>
      )}
      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && emails.length === 0 && <div className={styles.empty}>No emails found.</div>}
      {emails.map((email) => (
        <div
          key={email.id}
          className={styles.email}
          onClick={() => setSelectedEmailId(email.id)}
        >
          <div className={styles.subject}>{email.subject || '(no subject)'}</div>
          <div className={styles.meta}>
            <span className={styles.from}>{email.fromName || email.fromEmail}</span>
            <span className={styles.date}>
              {email.receivedAt
                ? new Date(email.receivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                : ''}
            </span>
          </div>
          {email.snippet && <div className={styles.snippet}>{email.snippet}</div>}
        </div>
      ))}

      {selectedEmailId && (
        <EmailDetailModal
          messageId={selectedEmailId}
          onClose={() => setSelectedEmailId(null)}
        />
      )}
    </div>
  )
}
