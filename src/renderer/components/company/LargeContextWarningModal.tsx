import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MemoPreflightResult } from '../../../shared/types/company'
import styles from './LargeContextWarningModal.module.css'

/**
 * Modal shown before memo generation when the estimated prompt size will be
 * "large" (totalChars > LARGE_CONTEXT_WARNING_CHARS, currently 150k chars).
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Headline:  ~Xk tokens, ~$Y.YY                                  │
 *   │  Subhead:   N files / M chars / breakdown by source             │
 *   │  Body:      file-by-file list (name, size, est chars)            │
 *   │  Footer:    [Cancel] [Continue]                                  │
 *   │                                                                  │
 *   │  Cancel: user goes to the Files tab to deselect manually         │
 *   │          (modal-deselect deferred to Phase 2)                    │
 *   │  Continue: proceed with generation                               │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Esc closes (Cancel). Continue button gets focus on open.
 *
 * Files are sorted by estChars DESC so the user spots the heaviest items
 * first. List scrolls when N is large (max-height: 60vh).
 */

interface Props {
  open: boolean
  preflight: MemoPreflightResult | null
  onConfirm: () => void
  onCancel: () => void
}

export default function LargeContextWarningModal({ open, preflight, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open || !preflight) return null

  const sortedFiles = [...preflight.fileBreakdown].sort((a, b) => b.estChars - a.estChars)
  const tokensK = Math.round(preflight.estTokens / 1_000)
  const cost = preflight.estCostUsd.toFixed(2)
  const totalCharsK = Math.round(preflight.totalChars / 1_000)

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="large-context-title">
      <div ref={dialogRef} className={styles.dialog}>
        <h2 id="large-context-title" className={styles.title}>Large memo context</h2>
        <p className={styles.headline}>
          ~<strong>{tokensK}k tokens</strong> (~<strong>${cost}</strong>) ·{' '}
          {preflight.flaggedFileCount} {preflight.flaggedFileCount === 1 ? 'file' : 'files'} ·{' '}
          {totalCharsK}k chars total
        </p>
        <p className={styles.subhead}>Generation will include:</p>
        <ul className={styles.breakdown}>
          {preflight.breakdown.meetings > 0 && (
            <li><strong>Meetings:</strong> ~{Math.round(preflight.breakdown.meetings / 1_000)}k chars</li>
          )}
          {preflight.breakdown.notes > 0 && (
            <li><strong>Notes:</strong> ~{Math.round(preflight.breakdown.notes / 1_000)}k chars</li>
          )}
          {preflight.breakdown.emails > 0 && (
            <li><strong>Emails:</strong> ~{Math.round(preflight.breakdown.emails / 1_000)}k chars</li>
          )}
          {preflight.breakdown.files > 0 && (
            <li><strong>Files:</strong> ~{Math.round(preflight.breakdown.files / 1_000)}k chars</li>
          )}
          {preflight.breakdown.externalResearch > 0 && (
            <li><strong>External research:</strong> ~{Math.round(preflight.breakdown.externalResearch / 1_000)}k chars</li>
          )}
          {preflight.breakdown.contactProfiles > 0 && (
            <li><strong>Contact profiles:</strong> ~{Math.round(preflight.breakdown.contactProfiles / 1_000)}k chars</li>
          )}
        </ul>

        {sortedFiles.length > 0 && (
          <>
            <p className={styles.subhead}>Flagged files (sorted by size):</p>
            <ul className={styles.fileList}>
              {sortedFiles.map(f => (
                <li key={f.name} className={styles.fileItem}>
                  <span className={styles.fileName}>{f.name}</span>
                  <span className={styles.fileSize}>~{Math.round(f.estChars / 1_000)}k chars</span>
                </li>
              ))}
            </ul>
            <p className={styles.hint}>To reduce context, unflag files on the Files tab and re-run.</p>
          </>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button type="button" ref={confirmRef} className={styles.confirmBtn} onClick={onConfirm}>
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
