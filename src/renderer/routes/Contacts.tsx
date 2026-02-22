import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import type { ContactSummary, ContactSyncResult } from '../../shared/types/contact'
import styles from './Contacts.module.css'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function Contacts() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: contactsEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<ContactSyncResult | null>(null)
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'

  const openCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.set('new', '1')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const closeCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const loadContacts = useCallback(async (searchQuery: string) => {
    if (!contactsEnabled) return
    setLoading(true)
    setError(null)
    try {
      const results = await window.api.invoke<ContactSummary[]>(
        IPC_CHANNELS.CONTACT_LIST,
        { query: searchQuery.trim(), limit: 500 }
      )
      setContacts(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [contactsEnabled])

  const syncContacts = useCallback(async () => {
    if (!contactsEnabled) return
    setSyncing(true)
    setError(null)
    try {
      const result = await window.api.invoke<ContactSyncResult>(
        IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS
      )
      setSyncResult(result)
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    } finally {
      setSyncing(false)
    }
  }, [contactsEnabled, loadContacts, query])

  const handleCreateContact = async () => {
    if (!newName.trim() || !newEmail.trim()) return
    try {
      await window.api.invoke<ContactSummary>(
        IPC_CHANNELS.CONTACT_CREATE,
        {
          fullName: newName.trim(),
          email: newEmail.trim(),
          title: newTitle.trim() || null
        }
      )
      closeCreateForm()
      setNewName('')
      setNewEmail('')
      setNewTitle('')
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    loadContacts(query)
  }, [loadContacts, query])

  useEffect(() => {
    if (!contactsEnabled) return
    let cancelled = false
    setSyncing(true)
    setError(null)
    window.api
      .invoke<ContactSyncResult>(IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS)
      .then((result) => {
        if (cancelled) return
        setSyncResult(result)
        return loadContacts('')
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
      })
      .finally(() => {
        if (cancelled) return
        setSyncing(false)
      })

    return () => {
      cancelled = true
    }
  }, [contactsEnabled, loadContacts])

  if (!flagsLoading && !contactsEnabled) {
    return (
      <EmptyState
        title="Contacts disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  const showEmptyState = !loading && contacts.length === 0 && !query && !showCreate

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <button className={styles.syncBtn} onClick={syncContacts} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync from meetings'}
        </button>
      </div>

      {syncResult && (
        <span className={styles.syncMeta}>
          {syncResult.inserted} new, {syncResult.updated} updated
        </span>
      )}

      {showCreate && (
        <div className={styles.createCard}>
          <input
            className={styles.input}
            placeholder="Contact name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className={styles.input}
            placeholder="Email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <input
            className={styles.input}
            placeholder="Title (optional)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button className={styles.createBtn} onClick={handleCreateContact}>
            Create
          </button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {query && (
        <p className={styles.resultCount}>
          {loading ? 'Searching...' : `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`}
        </p>
      )}

      <div className={styles.scrollArea}>
        {showEmptyState ? (
          <EmptyState
            title="No contacts yet"
            description="Contacts are synced from meeting attendees. Click 'Sync from meetings' to populate."
            action={{ label: '+ New Contact', onClick: openCreateForm }}
          />
        ) : (
          <div className={styles.section}>
            <h3 className={styles.sectionHeader}>
              Contacts ({contacts.length})
            </h3>
            <div className={styles.list}>
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  className={styles.card}
                  onClick={() => navigate(`/contact/${contact.id}`)}
                >
                  <div className={styles.cardRow}>
                    <span className={styles.cardName}>{contact.fullName}</span>
                    <span className={styles.cardEmail}>{contact.email || ''}</span>
                  </div>
                  <div className={styles.cardRow}>
                    <span className={styles.cardMeta}>
                      {contact.title || ''}
                    </span>
                    <span className={styles.cardDate}>
                      {formatDate(contact.updatedAt)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && contacts.length === 0 && query && (
          <p className={styles.noResults}>No contacts match your search.</p>
        )}
      </div>
    </div>
  )
}
