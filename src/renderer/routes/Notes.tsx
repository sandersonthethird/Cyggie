import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { usePicker } from '../hooks/usePicker'
import { EntityPicker } from '../components/common/EntityPicker'
import { api } from '../api'
import styles from './Notes.module.css'
import type { Note, NoteFilterView } from '../../shared/types/note'
import type { CompanySummary } from '../../shared/types/company'
import type { ContactSummary } from '../../shared/types/contact'

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const FILTERS: { label: string; value: NoteFilterView }[] = [
  { label: 'All', value: 'all' },
  { label: 'Untagged', value: 'untagged' },
  { label: 'Tagged', value: 'tagged' }
]

export default function Notes() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<NoteFilterView>('all')
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(() => searchParams.get('q') ?? '')

  // Bulk select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkPicker, setBulkPicker] = useState<'company' | 'contact' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [undoData, setUndoData] = useState<Note[] | null>(null)
  const lastCheckedRef = useRef<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const companyPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  const contactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(t)
  }, [searchQuery])

  const fetchNotes = useCallback(async () => {
    setLoading(true)
    try {
      const results = await api.invoke<Note[]>(
        IPC_CHANNELS.NOTES_LIST,
        filter,
        debouncedQuery || undefined
      )
      setNotes(results)
    } catch {
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [filter, debouncedQuery])

  useEffect(() => {
    void fetchNotes()
  }, [fetchNotes])

  // --- Toast helpers ---

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
      setUndoData(null)
    }, 4000)
  }, [])

  // --- Bulk handlers ---

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    const toDelete = notes.filter(n => selectedIds.has(n.id))
    const ids = [...selectedIds]
    const results = await Promise.allSettled(
      ids.map(id => api.invoke(IPC_CHANNELS.NOTES_DELETE, id))
    )
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.length - succeeded

    const deletedIds = new Set(
      ids.filter((_, i) => results[i].status === 'fulfilled')
    )
    setNotes(prev => prev.filter(n => !deletedIds.has(n.id)))
    setSelectedIds(new Set())
    lastCheckedRef.current = null

    setUndoData(toDelete.filter((_, i) => results[i].status === 'fulfilled'))
    if (failed === 0) {
      showToast(`Deleted ${succeeded} note${succeeded !== 1 ? 's' : ''} · Undo`)
    } else {
      showToast(`${succeeded} deleted · ${failed} failed`)
    }
  }, [selectedIds, notes, showToast])

  const handleBulkTag = useCallback(async (field: 'companyId' | 'contactId', value: string) => {
    const ids = [...selectedIds]
    const results = await Promise.allSettled(
      ids.map(id => api.invoke(IPC_CHANNELS.NOTES_UPDATE, id, { [field]: value }))
    )
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.length - succeeded

    setBulkPicker(null)
    setSelectedIds(new Set())
    lastCheckedRef.current = null
    void fetchNotes()

    if (failed > 0) showToast(`${succeeded} tagged · ${failed} failed`)
    else showToast(`${succeeded} note${succeeded !== 1 ? 's' : ''} tagged`)
  }, [selectedIds, fetchNotes, showToast])

  const handleUndo = useCallback(async () => {
    if (!undoData) return
    const toRestore = undoData
    setUndoData(null)
    setToast(null)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    await Promise.allSettled(
      toRestore.map(n =>
        api.invoke<Note>(IPC_CHANNELS.NOTES_CREATE, {
          title: n.title,
          content: n.content,
          companyId: n.companyId,
          contactId: n.contactId,
          themeId: n.themeId,
          sourceMeetingId: n.sourceMeetingId
        }).then(async (created) => {
          if (n.isPinned) {
            await api.invoke(IPC_CHANNELS.NOTES_UPDATE, created.id, { isPinned: true })
          }
        })
      )
    )
    void fetchNotes()
  }, [undoData, fetchNotes])

  // --- Selection helpers ---

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastCheckedRef.current = id
  }, [])

  const handleCheckbox = useCallback((e: React.MouseEvent, note: Note, index: number) => {
    e.stopPropagation()
    if (e.shiftKey && lastCheckedRef.current !== null) {
      const lastIndex = notes.findIndex(n => n.id === lastCheckedRef.current)
      if (lastIndex !== -1) {
        const start = Math.min(lastIndex, index)
        const end = Math.max(lastIndex, index)
        const rangeIds = notes.slice(start, end + 1).map(n => n.id)
        setSelectedIds(prev => {
          const next = new Set(prev)
          rangeIds.forEach(id => next.add(id))
          return next
        })
        lastCheckedRef.current = note.id
        return
      }
    }
    toggleSelected(note.id)
  }, [notes, toggleSelected])

  const handleCardClick = useCallback((note: Note) => {
    if (selectedIds.size > 0) {
      toggleSelected(note.id)
    } else {
      navigate(`/note/${note.id}`)
    }
  }, [selectedIds.size, toggleSelected, navigate])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === notes.length && notes.length > 0) {
      setSelectedIds(new Set())
      lastCheckedRef.current = null
    } else {
      setSelectedIds(new Set(notes.map(n => n.id)))
    }
  }, [selectedIds.size, notes])

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (selectedIds.size === 0) return
      if (e.key === 'Escape') {
        setSelectedIds(new Set())
        setBulkPicker(null)
        lastCheckedRef.current = null
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        void handleBulkDelete()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedIds, handleBulkDelete])

  // --- Other handlers ---

  const handleNewNote = useCallback(() => {
    navigate('/note/new')
  }, [navigate])

  const isEmpty = !loading && notes.length === 0
  const isSearching = debouncedQuery.trim().length > 0
  const allSelected = notes.length > 0 && selectedIds.size === notes.length

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Notes</h1>
        <button className={styles.newBtn} onClick={handleNewNote}>
          + New Note
        </button>
      </div>

      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search notes…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className={styles.searchClear} onClick={() => setSearchQuery('')}>
            ✕
          </button>
        )}
      </div>

      {selectedIds.size > 0 ? (
        <div className={styles.bulkBar}>
          <label className={styles.bulkSelectAll}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={handleSelectAll}
            />
            <span>{selectedIds.size} selected</span>
          </label>
          <button className={styles.bulkDeselect} onClick={() => {
            setSelectedIds(new Set())
            setBulkPicker(null)
            lastCheckedRef.current = null
          }}>
            ✕
          </button>
          <div className={styles.bulkActions}>
            {bulkPicker === 'company' ? (
              <EntityPicker<CompanySummary>
                picker={companyPicker}
                placeholder="Search company…"
                renderItem={(c) => c.canonicalName}
                onSelect={(c) => void handleBulkTag('companyId', c.id)}
                onClose={() => setBulkPicker(null)}
              />
            ) : bulkPicker === 'contact' ? (
              <EntityPicker<ContactSummary>
                picker={contactPicker}
                placeholder="Search contact…"
                renderItem={(c) => c.fullName}
                onSelect={(c) => void handleBulkTag('contactId', c.id)}
                onClose={() => setBulkPicker(null)}
              />
            ) : (
              <>
                <button className={styles.bulkBtn} onClick={() => setBulkPicker('company')}>
                  Tag Company
                </button>
                <button className={styles.bulkBtn} onClick={() => setBulkPicker('contact')}>
                  Tag Contact
                </button>
                <button className={`${styles.bulkBtn} ${styles.bulkDeleteBtn}`} onClick={() => void handleBulkDelete()}>
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        !searchQuery && (
          <div className={styles.filterBar}>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                className={`${styles.filterChip} ${filter === f.value ? styles.filterChipActive : ''}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )
      )}

      <div className={styles.list}>
        {isEmpty ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>📝</div>
            <div className={styles.emptyTitle}>
              {isSearching ? 'No notes match your search' : filter === 'all' ? 'No notes yet' : `No ${filter} notes`}
            </div>
            <div className={styles.emptyDesc}>
              {isSearching
                ? 'Try a different search term.'
                : filter === 'all'
                ? 'Press "+ New Note" or Cmd+Shift+N to capture a thought.'
                : filter === 'untagged'
                ? 'All your notes are tagged to a company or contact.'
                : 'Tag a note to a company or contact to see it here.'}
            </div>
          </div>
        ) : (
          notes.map((note, index) => {
            const firstLine =
              note.title ||
              note.content.split('\n').find((l) => l.trim()) ||
              ''
            const isSelected = selectedIds.has(note.id)

            return (
              <div
                key={note.id}
                className={`${styles.noteCard} ${isSelected ? styles.noteCardSelected : ''}`}
                onClick={() => handleCardClick(note)}
              >
                <label
                  className={styles.noteCheckbox}
                  onClick={(e) => handleCheckbox(e, note, index)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {/* handled by label onClick */}}
                  />
                </label>
                <div className={styles.noteContent}>
                  <div className={styles.noteTitle}>
                    {note.isPinned && <span className={styles.pinnedIcon}>📌</span>}
                    {firstLine ? (
                      firstLine
                    ) : (
                      <span className={styles.noteUntitled}>Untitled</span>
                    )}
                  </div>
                  {note.content && note.title && (
                    <div className={styles.noteSnippet}>{note.content}</div>
                  )}
                  {!note.title && note.content.includes('\n') && (
                    <div className={styles.noteSnippet}>
                      {note.content.split('\n').slice(1).join(' ').trim()}
                    </div>
                  )}
                  <div className={styles.noteMeta}>
                    {note.companyName && (
                      <span className={`${styles.metaBadge} ${styles.companyBadge}`}>
                        {note.companyName}
                      </span>
                    )}
                    {note.contactName && (
                      <span className={`${styles.metaBadge} ${styles.contactBadge}`}>
                        {note.contactName}
                      </span>
                    )}
                    <span className={styles.noteDate}>{formatDate(note.updatedAt)}</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {toast && (
        <div className={styles.toast}>
          <span>{toast}</span>
          {undoData && (
            <button className={styles.toastUndo} onClick={() => void handleUndo()}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
