import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyEmailRef } from '../../../shared/types/company'
import styles from './EmailDetailModal.module.css'

interface EmailDetailModalProps {
  messageId: string
  onClose: () => void
}

type State =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; email: CompanyEmailRef }

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

export function EmailDetailModal({ messageId, onClose }: EmailDetailModalProps) {
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    window.api
      .invoke<CompanyEmailRef | null>(IPC_CHANNELS.EMAIL_GET, messageId)
      .then((email) => {
        if (!email) {
          setState({ status: 'notFound' })
        } else {
          setState({ status: 'loaded', email })
        }
      })
      .catch((err) => {
        setState({ status: 'error', message: String(err) })
      })
  }, [messageId])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  function handleParticipantClick(contactId: string | null) {
    if (!contactId) return
    onClose()
    navigate(`/contact/${contactId}`)
  }

  const fromParticipants = state.status === 'loaded'
    ? state.email.participants.filter((p) => p.role === 'from')
    : []
  const toParticipants = state.status === 'loaded'
    ? state.email.participants.filter((p) => p.role === 'to')
    : []
  const ccParticipants = state.status === 'loaded'
    ? state.email.participants.filter((p) => p.role === 'cc')
    : []

  const dateStr = state.status === 'loaded'
    ? formatDate(state.email.receivedAt ?? state.email.sentAt)
    : ''

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.subject}>
            {state.status === 'loaded'
              ? (state.email.subject ?? '(no subject)')
              : state.status === 'loading' ? 'Loading…'
              : state.status === 'notFound' ? 'Email not found'
              : 'Error'}
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        {state.status === 'loading' && (
          <div className={styles.stateMsg}>Loading…</div>
        )}
        {state.status === 'notFound' && (
          <div className={styles.stateMsg}>This email could not be loaded.</div>
        )}
        {state.status === 'error' && (
          <div className={styles.stateMsg}>Failed to load email.</div>
        )}
        {state.status === 'loaded' && (
          <>
            <div className={styles.meta}>
              {fromParticipants.length > 0 && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>From</span>
                  <span className={styles.metaValue}>
                    {fromParticipants.map((p, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        {p.contactId ? (
                          <button
                            className={styles.participantLink}
                            onClick={() => handleParticipantClick(p.contactId)}
                          >
                            {p.displayName ?? p.email}
                          </button>
                        ) : (
                          <span>{p.displayName ?? p.email}</span>
                        )}
                        {p.displayName && <span className={styles.participantEmail}> &lt;{p.email}&gt;</span>}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {toParticipants.length > 0 && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>To</span>
                  <span className={styles.metaValue}>
                    {toParticipants.map((p, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        {p.contactId ? (
                          <button
                            className={styles.participantLink}
                            onClick={() => handleParticipantClick(p.contactId)}
                          >
                            {p.displayName ?? p.email}
                          </button>
                        ) : (
                          <span>{p.displayName ?? p.email}</span>
                        )}
                        {p.displayName && <span className={styles.participantEmail}> &lt;{p.email}&gt;</span>}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {ccParticipants.length > 0 && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>CC</span>
                  <span className={styles.metaValue}>
                    {ccParticipants.map((p, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        {p.contactId ? (
                          <button
                            className={styles.participantLink}
                            onClick={() => handleParticipantClick(p.contactId)}
                          >
                            {p.displayName ?? p.email}
                          </button>
                        ) : (
                          <span>{p.displayName ?? p.email}</span>
                        )}
                        {p.displayName && <span className={styles.participantEmail}> &lt;{p.email}&gt;</span>}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {dateStr && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Date</span>
                  <span className={styles.metaValue}>{dateStr}</span>
                </div>
              )}
            </div>
            <div className={styles.divider} />
            <div className={styles.body}>
              {state.email.bodyText?.trim()
                ? state.email.bodyText
                : <span className={styles.noBody}>(no body)</span>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
