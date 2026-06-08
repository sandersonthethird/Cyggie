/**
 * MergeReviewModal — per-pair review dialog for merging two companies.
 *
 * Used by both the kebab "Merge" flow on a company detail page and the bulk
 * dedup flow in the Companies route. Loads a CompanyMergePreview from the
 * backend, lets the user pick per-field which side wins for any conflicts,
 * and confirms the merge with explicit fieldOverrides.
 *
 * Behavior:
 *   - On open → fetch COMPANY_MERGE_PREVIEW.
 *   - If preview has no conflicts and no auto-fill → simplified confirm.
 *   - Otherwise:
 *       - Conflict rows render a target/source side-by-side with a radio per
 *         row. Default = keep target (status quo).
 *       - Auto-fill fields render in a collapsed accordion. Default for each
 *         is "take source value" (since target is empty); user can opt-out
 *         per row (drops to null/empty on target).
 *       - Array-union summary renders as a small footnote.
 *   - On confirm → builds fieldOverrides from the radio state and calls
 *     COMPANY_MERGE.
 */
import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import type { CompanyMergePreview, MergeFieldOverrides } from '../../../shared/types/company'
import styles from './MergeReviewModal.module.css'

interface MergeReviewModalProps {
  open: boolean
  /** The company that will REMAIN after merge. */
  targetId: string
  /** The company that will be DELETED after merge. */
  sourceId: string
  onCancel: () => void
  /** Called with the kept company's id after a successful merge. */
  onSuccess: (mergedCompanyId: string) => void
}

type Side = 'target' | 'source' | 'drop'

export function MergeReviewModal({
  open,
  targetId,
  sourceId,
  onCancel,
  onSuccess,
}: MergeReviewModalProps) {
  const [preview, setPreview] = useState<CompanyMergePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // For each conflicting column: which side's value to write. Default 'target'.
  const [conflictPicks, setConflictPicks] = useState<Record<string, 'target' | 'source'>>({})
  // For each auto-fill column: 'source' (default — accept source value) or 'drop' (write null).
  const [autoFillPicks, setAutoFillPicks] = useState<Record<string, 'source' | 'drop'>>({})
  const [autoFillExpanded, setAutoFillExpanded] = useState(false)

  // Reset state on open / id change.
  useEffect(() => {
    if (!open) return
    setPreview(null)
    setError(null)
    setConflictPicks({})
    setAutoFillPicks({})
    setAutoFillExpanded(false)
    setLoading(true)
    api.invoke<CompanyMergePreview>(IPC_CHANNELS.COMPANY_MERGE_PREVIEW, targetId, sourceId)
      .then((result) => {
        setPreview(result)
        // Default conflict picks = target (status quo).
        const cp: Record<string, 'target' | 'source'> = {}
        for (const c of result.conflicts) cp[c.column] = 'target'
        setConflictPicks(cp)
        // Default auto-fill picks = source (take it).
        const ap: Record<string, 'source' | 'drop'> = {}
        for (const c of result.autoFill) ap[c.column] = 'source'
        setAutoFillPicks(ap)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [open, targetId, sourceId])

  const handleConfirm = useCallback(async () => {
    if (!preview || merging) return
    setMerging(true)
    setError(null)
    try {
      // Build fieldOverrides:
      //   - For conflict picks set to 'source' → write source value.
      //   - For conflict picks set to 'target' → no override (target stays; default).
      //   - For auto-fill picks set to 'drop' → explicit null override (overrides
      //     the default auto-fill behavior in the backend).
      //   - For auto-fill picks set to 'source' → no override (backend's default
      //     auto-fill takes source's value).
      const overrides: MergeFieldOverrides = {}
      for (const c of preview.conflicts) {
        if (conflictPicks[c.column] === 'source') {
          // Source value as written in the DB. We have stringified preview
          // values; the backend stores either string or numeric. Numbers
          // round-trip through Number() if the column expects a number; but
          // since we don't know column types here, pass the stringified value.
          // SQLite is permissive about types; downstream readers parse as
          // needed. (Same constraint the import flow accepts.)
          overrides[c.column] = c.sourceValue
        }
      }
      for (const c of preview.autoFill) {
        if (autoFillPicks[c.column] === 'drop') {
          overrides[c.column] = null
        }
      }
      await api.invoke(IPC_CHANNELS.COMPANY_MERGE, targetId, sourceId, overrides)
      onSuccess(targetId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }, [preview, conflictPicks, autoFillPicks, targetId, sourceId, onSuccess, merging])

  const handleCancel = useCallback(() => {
    if (merging) return
    onCancel()
  }, [merging, onCancel])

  // Escape to cancel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, handleCancel])

  if (!open) return null

  const hasNothingToReview = preview !== null
    && preview.conflicts.length === 0
    && preview.autoFill.length === 0

  return createPortal(
    <div className={styles.overlay} onClick={handleCancel}>
      <div className={styles.dialog} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.title}>
            {preview
              ? <>Merge &ldquo;{preview.source.canonicalName}&rdquo; into &ldquo;{preview.target.canonicalName}&rdquo;</>
              : 'Merge companies'}
          </h2>
          {preview && (
            <p className={styles.subtitle}>
              {preview.conflicts.length} conflict{preview.conflicts.length !== 1 ? 's' : ''} ·{' '}
              {preview.autoFill.length} auto-fill{preview.autoFill.length !== 1 ? 's' : ''}
              {preview.arrayUnions.length > 0 && (
                <>
                  {' · '}
                  {preview.arrayUnions.map((u) => `+${u.addedCount} ${u.name.toLowerCase()}`).join(', ')}
                </>
              )}
            </p>
          )}
        </header>

        {loading && <p className={styles.statusText}>Loading preview…</p>}

        {!loading && preview && hasNothingToReview && (
          <p className={styles.statusText}>
            No field conflicts. Source company will be removed and any related
            records (meetings, contacts, notes, investors) will be linked to
            the target.
          </p>
        )}

        {!loading && preview && preview.conflicts.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Conflicting fields</h3>
            <p className={styles.sectionHint}>
              Both companies have a value for these fields. Pick which one to keep.
            </p>
            <table className={styles.diffTable}>
              <thead>
                <tr>
                  <th className={styles.fieldCol}>Field</th>
                  <th>Keep target<br/><span className={styles.thNameHint}>{preview.target.canonicalName}</span></th>
                  <th>Take from source<br/><span className={styles.thNameHint}>{preview.source.canonicalName}</span></th>
                </tr>
              </thead>
              <tbody>
                {preview.conflicts.map((c) => (
                  <tr key={c.column}>
                    <td className={styles.fieldCol}>{c.label}</td>
                    <td>
                      <label className={styles.radioCell}>
                        <input
                          type="radio"
                          name={`conflict-${c.column}`}
                          checked={conflictPicks[c.column] === 'target'}
                          onChange={() => setConflictPicks((s) => ({ ...s, [c.column]: 'target' }))}
                        />
                        <span className={styles.cellValue}>{c.targetValue ?? <em>—</em>}</span>
                      </label>
                    </td>
                    <td>
                      <label className={styles.radioCell}>
                        <input
                          type="radio"
                          name={`conflict-${c.column}`}
                          checked={conflictPicks[c.column] === 'source'}
                          onChange={() => setConflictPicks((s) => ({ ...s, [c.column]: 'source' }))}
                        />
                        <span className={styles.cellValue}>{c.sourceValue ?? <em>—</em>}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {!loading && preview && preview.autoFill.length > 0 && (
          <section className={styles.section}>
            <button
              type="button"
              className={styles.accordionToggle}
              onClick={() => setAutoFillExpanded((v) => !v)}
              aria-expanded={autoFillExpanded}
            >
              <span className={styles.accordionChevron}>{autoFillExpanded ? '▾' : '▸'}</span>
              {preview.autoFill.length} field{preview.autoFill.length !== 1 ? 's' : ''} auto-fill from source
              <span className={styles.accordionHint}>(target is empty)</span>
            </button>
            {autoFillExpanded && (
              <table className={styles.diffTable}>
                <thead>
                  <tr>
                    <th className={styles.fieldCol}>Field</th>
                    <th>Source value</th>
                    <th className={styles.dropCol}>Drop</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.autoFill.map((c) => (
                    <tr key={c.column}>
                      <td className={styles.fieldCol}>{c.label}</td>
                      <td>
                        <label className={styles.radioCell}>
                          <input
                            type="radio"
                            name={`autofill-${c.column}`}
                            checked={autoFillPicks[c.column] === 'source'}
                            onChange={() => setAutoFillPicks((s) => ({ ...s, [c.column]: 'source' }))}
                          />
                          <span className={styles.cellValue}>{c.sourceValue ?? <em>—</em>}</span>
                        </label>
                      </td>
                      <td className={styles.dropCol}>
                        <input
                          type="radio"
                          name={`autofill-${c.column}`}
                          aria-label={`Drop ${c.label}`}
                          checked={autoFillPicks[c.column] === 'drop'}
                          onChange={() => setAutoFillPicks((s) => ({ ...s, [c.column]: 'drop' }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {error && <p className={styles.errorText} role="alert">{error}</p>}

        <footer className={styles.footer}>
          <button className={styles.cancelButton} onClick={handleCancel} disabled={merging}>Cancel</button>
          <button
            className={styles.confirmButton}
            onClick={handleConfirm}
            disabled={loading || merging || !preview}
          >
            {merging ? 'Merging…' : 'Apply merge'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
