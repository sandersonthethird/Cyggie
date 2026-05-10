import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ChatContextSizeEstimate } from '../../../shared/types/company'
import styles from './ChatContextSizeBanner.module.css'

/**
 * Persistent banner above the chat input. Shows the running context-size
 * budget for company-scoped chat: how many flagged files, how many chars
 * the LLM will see per message.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Renders ONLY when companyId is provided. Other chat kinds      │
 *   │  (meeting / global / contact) get nothing.                       │
 *   │                                                                  │
 *   │  Refreshes:                                                       │
 *   │   - on mount                                                      │
 *   │   - when companyId changes                                        │
 *   │   - on COMPANY_FLAGS_CHANGED IPC broadcast (300ms debounced)     │
 *   │                                                                  │
 *   │  Fail-open: if the preflight IPC throws, no banner renders;      │
 *   │  console.warn only. Chat is still functional without it.          │
 *   └────────────────────────────────────────────────────────────────┘
 */

const REFRESH_DEBOUNCE_MS = 300

interface Props {
  companyId: string | null
  onManageFiles?: () => void
}

export default function ChatContextSizeBanner({ companyId, onManageFiles }: Props) {
  const [estimate, setEstimate] = useState<ChatContextSizeEstimate | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!companyId) {
      setEstimate(null)
      return
    }

    let cancelled = false
    function fetchEstimate() {
      void api
        .invoke<ChatContextSizeEstimate>(IPC_CHANNELS.CHAT_CONTEXT_SIZE_PREFLIGHT, companyId)
        .then(result => { if (!cancelled) setEstimate(result) })
        .catch(err => {
          if (!cancelled) {
            console.warn('[chat-context-banner] preflight failed:', err)
            setEstimate(null)
          }
        })
    }

    fetchEstimate()

    // Listen for COMPANY_FLAGS_CHANGED broadcasts. Debounce so rapid toggles
    // don't trigger an IPC storm.
    const off = api.on(IPC_CHANNELS.COMPANY_FLAGS_CHANGED, (...args: unknown[]) => {
      const payload = args[0] as { companyId: string } | undefined
      if (!payload || payload.companyId !== companyId) return
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(fetchEstimate, REFRESH_DEBOUNCE_MS)
    })

    return () => {
      cancelled = true
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      off()
    }
  }, [companyId])

  // Don't render when no estimate (no company OR error path) OR when there's
  // nothing meaningful to show (no flagged files AND zero meaningful context).
  if (!estimate || estimate.flaggedFileCount === 0) return null

  const charsK = Math.round(estimate.totalChars / 1_000)

  return (
    <div className={styles.banner} role="status" aria-label="Chat context size">
      <span className={styles.summary}>
        {estimate.flaggedFileCount} {estimate.flaggedFileCount === 1 ? 'file' : 'files'} ·
        {' '}~{charsK}k chars context per message
      </span>
      {onManageFiles && (
        <button type="button" className={styles.manageBtn} onClick={onManageFiles}>
          Manage files →
        </button>
      )}
    </div>
  )
}
