import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Spinner } from '../common/Spinner'
import styles from './IncorporateCallModal.module.css'

export interface NewMeetingRef {
  id: string
  title: string
  date: string
}

/**
 * Two-phase modal for "Incorporate new call":
 *
 *   phase 'confirm'  — show meetings added since the last memo (pre-checked,
 *                      adjustable) + counts of auto-included notes/emails.
 *   phase 'pick'     — fallback when Haiku triage fails: user picks which
 *                      sections to update from the memo's present headings.
 *
 * The parent owns the run; this component only collects the user's selection.
 */
interface IncorporateCallModalProps {
  phase: 'confirm' | 'pick'
  meetings: NewMeetingRef[]
  noteCount: number
  emailCount: number
  sectionOptions: string[]
  busy: boolean
  onConfirm: (meetingIds: string[]) => void
  onPickSections: (sections: string[]) => void
  onCancel: () => void
}

export default function IncorporateCallModal({
  phase,
  meetings,
  noteCount,
  emailCount,
  sectionOptions,
  busy,
  onConfirm,
  onPickSections,
  onCancel,
}: IncorporateCallModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Meetings pre-checked; user can deselect.
  const [selectedMeetings, setSelectedMeetings] = useState<Set<string>>(
    () => new Set(meetings.map((m) => m.id)),
  )
  const [selectedSections, setSelectedSections] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const extras: string[] = []
  if (noteCount > 0) extras.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`)
  if (emailCount > 0) extras.push(`${emailCount} email${emailCount === 1 ? '' : 's'}`)

  const confirmDisabled =
    busy || (phase === 'confirm' ? selectedMeetings.size === 0 && noteCount === 0 && emailCount === 0 : selectedSections.size === 0)

  return createPortal(
    <div className={styles.overlay} onClick={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'confirm' ? (
          <>
            <h2 className={styles.title}>Incorporate new material</h2>
            {meetings.length > 0 ? (
              <>
                <p className={styles.subtitle}>New calls since the last memo:</p>
                <ul className={styles.list}>
                  {meetings.map((m) => (
                    <li key={m.id} className={styles.row}>
                      <label className={styles.label}>
                        <input
                          type="checkbox"
                          checked={selectedMeetings.has(m.id)}
                          onChange={() => setSelectedMeetings((s) => toggle(s, m.id))}
                          disabled={busy}
                        />
                        <span className={styles.meetingTitle}>{m.title}</span>
                        <span className={styles.meetingDate}>{m.date}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className={styles.subtitle}>No new calls since the last memo.</p>
            )}
            {extras.length > 0 && (
              <p className={styles.extras}>Also including {extras.join(' and ')} added since the last memo.</p>
            )}
          </>
        ) : (
          <>
            <h2 className={styles.title}>Which sections should change?</h2>
            <p className={styles.subtitle}>
              Auto-detection wasn’t available — pick the sections the new material affects.
            </p>
            <ul className={styles.list}>
              {sectionOptions.map((s) => (
                <li key={s} className={styles.row}>
                  <label className={styles.label}>
                    <input
                      type="checkbox"
                      checked={selectedSections.has(s)}
                      onChange={() => setSelectedSections((prev) => toggle(prev, s))}
                      disabled={busy}
                    />
                    <span className={styles.meetingTitle}>{s}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className={styles.actions}>
          <button className={styles.cancelButton} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={styles.confirmButton}
            disabled={confirmDisabled}
            onClick={() =>
              phase === 'confirm'
                ? onConfirm([...selectedMeetings])
                : onPickSections([...selectedSections])
            }
          >
            {busy && <Spinner size="sm" />}
            {busy ? 'Working…' : phase === 'confirm' ? 'Incorporate' : 'Update sections'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
