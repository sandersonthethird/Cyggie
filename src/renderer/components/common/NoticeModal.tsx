/**
 * NoticeModal — Crimson Velocity Design System
 *
 * Global feedback modal replacing all browser alert() calls.
 * Wired via React context so any handler can call notice.show()
 * without managing local modal state.
 *
 * Data flow:
 *   notice.show({ variant, title, url?, message? })
 *     → NoticeModalProvider setState (openCount++)
 *       → <NoticeModal> portal renders into document.body
 *         ├── [success] useEffect: setTimeout(close, 3000)
 *         └── [error]   no timer, requires manual dismiss
 *
 * Progress bar animation restart:
 *   `key={openCount}` on the progress bar div forces React to
 *   remount it on every show(), replaying @keyframes from scratch.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import styles from './NoticeModal.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

interface NoticeState {
  open: boolean
  openCount: number
  variant: 'success' | 'error'
  title: string
  url?: string
  message?: string
}

interface NoticeContextValue {
  show: (opts: Omit<NoticeState, 'open' | 'openCount'>) => void
}

// ─── Context + hook ───────────────────────────────────────────────────────────

const NoticeModalContext = createContext<NoticeContextValue | null>(null)

export function useNotice(): NoticeContextValue {
  const ctx = useContext(NoticeModalContext)
  if (!ctx) throw new Error('useNotice must be used within NoticeModalProvider')
  return ctx
}

// ─── Modal inner component ────────────────────────────────────────────────────

const INITIAL_STATE: NoticeState = {
  open: false,
  openCount: 0,
  variant: 'success',
  title: '',
}

function NoticeModalInner({ state, onClose }: { state: NoticeState; onClose: () => void }) {
  const { open, openCount, variant, title, url, message } = state
  const okRef = useRef<HTMLButtonElement>(null)

  // Auto-dismiss success notices after 3 seconds.
  // useEffect deps include openCount so the timer restarts if show() is called
  // while the modal is already open (the key on progressBar also restarts the CSS animation).
  useEffect(() => {
    if (!open || variant !== 'success') return
    const timer = setTimeout(onClose, 3000)
    return () => clearTimeout(timer)
  }, [open, openCount, variant, onClose])

  // Focus OK on open for keyboard accessibility.
  useEffect(() => {
    if (open) okRef.current?.focus()
  }, [open])

  // Escape key to close.
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notice-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon circle */}
        <div className={styles.iconWrap}>
          {variant === 'success' ? (
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <path
                d="M4.5 11L9 15.5L17.5 7"
                stroke="var(--cv-crimson)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <path
                d="M7 7L15 15M15 7L7 15"
                stroke="var(--cv-crimson)"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </div>

        {/* Title */}
        <h2 id="notice-modal-title" className={styles.title}>
          {title}
        </h2>

        {/* Error message body */}
        {message && <p className={styles.message}>{message}</p>}

        {/* URL display strip */}
        {url && (
          <div className={styles.urlStrip}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span className={styles.urlText}>{url}</span>
          </div>
        )}

        {/* Primary action */}
        <button ref={okRef} className={styles.okButton} onClick={onClose}>
          OK
        </button>

        {/* Branding */}
        <p className={styles.branding}>POWERED BY INSIGHTCRM</p>

        {/* Auto-dismiss progress bar — keyed on openCount so @keyframes restarts on re-open */}
        {variant === 'success' && (
          <div key={openCount} className={styles.progressBar} aria-hidden="true" />
        )}
      </div>
    </div>,
    document.body
  )
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function NoticeModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NoticeState>(INITIAL_STATE)

  const show = useCallback((opts: Omit<NoticeState, 'open' | 'openCount'>) => {
    setState((prev) => ({
      ...opts,
      open: true,
      openCount: prev.openCount + 1,
    }))
  }, [])

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }))
  }, [])

  return (
    <NoticeModalContext.Provider value={{ show }}>
      {children}
      <NoticeModalInner state={state} onClose={close} />
    </NoticeModalContext.Provider>
  )
}
