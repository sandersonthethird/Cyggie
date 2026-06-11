import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ChatContextSizeEstimate } from '../../../shared/types/company'
import styles from './ChatContextSizeBanner.module.css'

/**
 * Persistent banner above the chat input. Shows the running context-size
 * budget across the chat's attached companies: how many flagged files, how
 * many chars the LLM will see per message. The estimate is DEDUPED across
 * companies (matching queryEntities) so a company + its own contact don't
 * double-count shared meetings/files.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Renders only when ≥1 attached COMPANY contributes flagged       │
 *   │  files. Contacts have no size preflight yet (see TODOS.md), so   │
 *   │  contact-only chats show nothing.                                │
 *   │                                                                  │
 *   │  Refreshes:                                                       │
 *   │   - on mount                                                      │
 *   │   - when the attached company-id set changes                     │
 *   │   - on COMPANY_FLAGS_CHANGED for any attached company (debounced)│
 *   │                                                                  │
 *   │  Fail-open: if the preflight IPC throws, no banner renders;      │
 *   │  console.warn only. Chat is still functional without it.          │
 *   └────────────────────────────────────────────────────────────────┘
 */

const REFRESH_DEBOUNCE_MS = 300

interface Props {
  /** Attached company ids whose deduped context size to aggregate. */
  companyIds: string[]
  onManageFiles?: () => void
}

export default function ChatContextSizeBanner({ companyIds, onManageFiles }: Props) {
  const [estimate, setEstimate] = useState<ChatContextSizeEstimate | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable key so the effect re-runs only when the actual id set changes,
  // not on every render (companyIds is a fresh array each parent render).
  const idsKey = [...companyIds].sort().join(',')

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : []
    if (ids.length === 0) {
      setEstimate(null)
      return
    }

    let cancelled = false
    function fetchEstimate() {
      void api
        .invoke<ChatContextSizeEstimate>(IPC_CHANNELS.CHAT_CONTEXT_SIZE_PREFLIGHT_MULTI, ids)
        .then(result => { if (!cancelled) setEstimate(result) })
        .catch(err => {
          if (!cancelled) {
            console.warn('[chat-context-banner] preflight failed:', err)
            setEstimate(null)
          }
        })
    }

    fetchEstimate()

    // Refresh when flags change for any attached company. Debounce so rapid
    // toggles don't trigger an IPC storm.
    const off = api.on(IPC_CHANNELS.COMPANY_FLAGS_CHANGED, (...args: unknown[]) => {
      const payload = args[0] as { companyId: string } | undefined
      if (!payload || !ids.includes(payload.companyId)) return
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(fetchEstimate, REFRESH_DEBOUNCE_MS)
    })

    return () => {
      cancelled = true
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      off()
    }
  }, [idsKey])

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
