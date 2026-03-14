import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactEmailIngestResult, ContactEmailRef } from '../../../shared/types/contact'
import { EmailDetailModal } from '../crm/EmailDetailModal'
import styles from './ContactEmails.module.css'

interface ContactEmailsProps {
  contactId: string
  className?: string
}

function getLastSyncedLabel(key: string): string {
  const raw = localStorage.getItem(key)
  if (!raw) return 'Never synced'
  const mins = Math.floor((Date.now() - new Date(raw).getTime()) / 60000)
  if (mins < 1) return 'Last synced just now'
  if (mins < 60) return `Last synced ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Last synced ${hours}h ago`
  return `Last synced ${Math.floor(hours / 24)}d ago`
}

export function ContactEmails({ contactId, className }: ContactEmailsProps) {
  const [emails, setEmails] = useState<ContactEmailRef[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  useEffect(() => () => { isMountedRef.current = false }, [])

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<ContactEmailIngestResult | null>(null)
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string>(
    () => getLastSyncedLabel(`sync:contact:${contactId}`)
  )

  async function handleSync() {
    if (!isMountedRef.current) return
    setIsSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await window.api.invoke<ContactEmailIngestResult>(
        IPC_CHANNELS.CONTACT_EMAIL_INGEST, contactId
      )
      if (!isMountedRef.current) return
      setSyncResult(result)
      setLoaded(false)
      const key = `sync:contact:${contactId}`
      localStorage.setItem(key, new Date().toISOString())
      setLastSyncedLabel('Last synced just now')
    } catch (err) {
      if (!isMountedRef.current) return
      setSyncError(err instanceof Error ? err.message : 'Sync failed.')
    } finally {
      if (isMountedRef.current) setIsSyncing(false)
    }
  }

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<ContactEmailRef[]>(IPC_CHANNELS.CONTACT_EMAILS, contactId)
      .then((data) => setEmails(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [contactId, loaded])

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {(loaded || isSyncing) && (
        <div className={styles.syncRow}>
          <span className={styles.lastSynced}>{lastSyncedLabel}</span>
          <button
            className={styles.syncBtn}
            onClick={handleSync}
            disabled={isSyncing}
            title="Pull emails from Gmail for this contact"
          >
            <span className={isSyncing ? styles.spinning : ''}>↻</span>
            {' '}{isSyncing ? 'Syncing…' : 'Sync emails'}
          </button>
          {syncResult && !isSyncing && (
            <span className={styles.syncMsg}>
              {syncResult.insertedMessageCount > 0
                ? `+${syncResult.insertedMessageCount} new`
                : 'Up to date'}
            </span>
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
