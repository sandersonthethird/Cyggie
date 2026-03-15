import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDecisionLog, CompanyNote } from '../../../shared/types/company'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import styles from './CompanyNotes.module.css'
import { api } from '../../api'

interface CompanyNotesProps {
  companyId: string
  className?: string
}

const DECISION_ACCENT: Record<string, string> = {
  'Investment Approved': styles.accentGreen,
  'Increase Allocation': styles.accentGreen,
  'Follow-on': styles.accentGreen,
  'Pass': styles.accentRed,
  'Write-Off': styles.accentAmber,
}

function decisionAccentClass(type: string): string {
  return DECISION_ACCENT[type] ?? styles.accentGrey
}

function formatDecisionDate(dateStr: string): string {
  // dateStr is ISO date "2026-03-14"
  const [year, month] = dateStr.split('-')
  const d = new Date(Number(year), Number(month) - 1, 1)
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

interface DecisionLogSectionProps {
  companyId: string
  onDecisionSaved?: (log: CompanyDecisionLog) => void
}

function DecisionLogSection({ companyId, onDecisionSaved }: DecisionLogSectionProps) {
  const [decisions, setDecisions] = useState<CompanyDecisionLog[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editLogId, setEditLogId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    api.invoke<CompanyDecisionLog[]>(IPC_CHANNELS.COMPANY_DECISION_LOG_LIST, companyId)
      .then((data) => setDecisions(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId])

  function handleSaved(log: CompanyDecisionLog) {
    setDecisions((prev) => {
      const existing = prev.findIndex((d) => d.id === log.id)
      if (existing >= 0) {
        return prev.map((d) => (d.id === log.id ? log : d))
      }
      return [log, ...prev]
    })
    setEditLogId(null)
    setShowCreate(false)
    onDecisionSaved?.(log)
  }

  function handleDeleted(logId: string) {
    setDecisions((prev) => prev.filter((d) => d.id !== logId))
    setEditLogId(null)
  }

  // Arc: ordered chronologically (ASC), truncated to first + ... + last 2 if > 5
  const arcItems = [...decisions].sort((a, b) =>
    a.decisionDate.localeCompare(b.decisionDate)
  )
  const showArc = arcItems.length >= 2
  let arcDisplay = arcItems
  if (arcItems.length > 5) {
    arcDisplay = [arcItems[0], { ...arcItems[0], id: '__ellipsis__', decisionType: '…' }, ...arcItems.slice(-2)]
  }

  return (
    <div className={styles.decisionSection}>
      <div className={styles.decisionHeader}>
        <span className={styles.decisionSectionLabel}>Decision Log</span>
        <button
          className={styles.addDecisionBtn}
          onClick={() => setShowCreate(true)}
        >
          + Add Decision
        </button>
      </div>

      {/* History arc */}
      {showArc && (
        <div className={styles.decisionArc}>
          {arcDisplay.map((d, i) => (
            <span key={d.id} className={styles.arcItem}>
              {i > 0 && <span className={styles.arcArrow}>→</span>}
              <span className={`${styles.arcChip} ${d.id === '__ellipsis__' ? '' : decisionAccentClass(d.decisionType)}`}>
                <span className={styles.arcChipType}>{d.decisionType}</span>
                {d.id !== '__ellipsis__' && (
                  <span className={styles.arcChipDate}>{formatDecisionDate(d.decisionDate)}</span>
                )}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Empty state */}
      {loaded && decisions.length === 0 && (
        <button
          className={styles.decisionEmpty}
          onClick={() => setShowCreate(true)}
        >
          Log your first decision →
        </button>
      )}

      {/* Decision cards (most recent first) */}
      {decisions.map((d) => (
        <div key={d.id} className={`${styles.decisionCard} ${decisionAccentClass(d.decisionType)}`}>
          <div className={styles.decisionCardTop}>
            <span className={styles.decisionTypeBadge}>{d.decisionType}</span>
            <span className={styles.decisionCardDate}>{d.decisionDate}</span>
          </div>
          <div className={styles.decisionCardMeta}>
            {d.decisionOwner && <span>{d.decisionOwner}</span>}
            {d.amountApproved && <span>{d.amountApproved}</span>}
            {d.targetOwnership && (
              <span>{d.targetOwnership}{d.moreIfPossible ? ' (more if possible)' : ''}</span>
            )}
          </div>
          {d.structure && (
            <div className={styles.decisionCardStructure}>{d.structure}</div>
          )}
          <div className={styles.decisionCardActions}>
            <button
              className={styles.decisionEditBtn}
              onClick={() => setEditLogId(d.id)}
            >
              Edit
            </button>
          </div>
        </div>
      ))}

      {/* Create modal */}
      {showCreate && (
        <DecisionLogModal
          companyId={companyId}
          onClose={() => setShowCreate(false)}
          onSaved={handleSaved}
        />
      )}

      {/* Edit modal */}
      {editLogId && (
        <DecisionLogModal
          companyId={companyId}
          logId={editLogId}
          onClose={() => setEditLogId(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}

export function CompanyNotes({ companyId, className }: CompanyNotesProps) {
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      .then((data) => setNotes(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  async function createNote() {
    if (!newContent.trim()) return
    setCreating(true)
    try {
      const note = await api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        content: newContent.trim()
      })
      setNotes((prev) => [note, ...prev])
      setNewContent('')
      setFocused(false)
    } catch (e) {
      console.error('[CompanyNotes] create failed:', e)
    } finally {
      setCreating(false)
    }
  }

  function cancelNote() {
    setNewContent('')
    setFocused(false)
    textareaRef.current?.blur()
  }

  function handleNoteUpdated(updated: CompanyNote) {
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
  }

  function handleNoteDeleted(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId))
    setSelectedNoteId(null)
  }

  async function deleteNote(noteId: string) {
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    } catch (e) {
      console.error('[CompanyNotes] delete failed:', e)
    }
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {/* Decision Log section at top */}
      <DecisionLogSection companyId={companyId} />

      <div className={styles.notesDivider} />

      <div className={styles.newNote}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Add a note…"
          rows={focused ? 5 : 1}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) createNote()
            if (e.key === 'Escape') cancelNote()
          }}
        />
        {focused && (
          <div className={styles.noteActions}>
            <button className={styles.cancelBtn} onClick={cancelNote} disabled={creating}>
              Cancel
            </button>
            <button
              className={styles.saveBtn}
              onClick={createNote}
              disabled={!newContent.trim() || creating}
            >
              Save Note
            </button>
          </div>
        )}
      </div>

      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && notes.length === 0 && (
        <div className={styles.empty}>No notes yet.</div>
      )}

      {notes.map((note) => {
        const content = note.content || ''
        const nl = content.indexOf('\n')
        const firstLine = nl >= 0 ? content.slice(0, nl) : content
        const explicitTitle = note.title?.trim()
        const title = explicitTitle || firstLine
        const body = explicitTitle
          ? (nl >= 0 && firstLine.trim() === explicitTitle
            ? content.slice(nl + 1).trim()
            : content.trim())
          : (nl >= 0 ? content.slice(nl + 1).trim() : '')
        return (
          <div key={note.id} className={styles.note} onClick={() => setSelectedNoteId(note.id)}>
            <div className={styles.noteTitle}>{title}</div>
            {body && <div className={styles.noteBody}>{body}</div>}
            <div className={styles.noteMeta}>
              <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <button
                className={styles.deleteBtn}
                onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
              >Delete</button>
            </div>
          </div>
        )
      })}

      {selectedNoteId && (
        <NoteDetailModal
          noteId={selectedNoteId}
          onClose={() => setSelectedNoteId(null)}
          onDeleted={handleNoteDeleted}
          onUpdated={handleNoteUpdated}
        />
      )}
    </div>
  )
}
