import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { usePicker } from '../hooks/usePicker'
import { usePanelResize } from '../hooks/usePanelResize'
import { EntityPicker } from '../components/common/EntityPicker'
import { FolderSidebar, INBOX_SENTINEL } from '../components/notes/FolderSidebar'
import NotePaneEditor from '../components/notes/NotePaneEditor'
import { api } from '../api'
import { stripMarkdownPreview } from '../utils/format'
import styles from './Notes.module.css'
import type { Note, NoteFilterView, TagSuggestion } from '../../shared/types/note'
import type { CompanySummary } from '../../shared/types/company'
import type { ContactSummary } from '../../shared/types/contact'

/**
 * Returns the calendar-day grouping label for a note's updatedAt date.
 * Uses midnight-truncated dates so "Yesterday" means the previous calendar
 * day — not "24 hours ago".
 */
export function getDateGroup(dateStr: string): string {
  const note = new Date(dateStr)
  const today = new Date()
  const noteDay  = new Date(note.getFullYear(),  note.getMonth(),  note.getDate())
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diffDays = Math.floor((todayDay.getTime() - noteDay.getTime()) / 86_400_000)
  if (isNaN(diffDays) || diffDays < 0) return 'Older'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This Week'
  if (diffDays < 30) return 'This Month'
  return 'Older'
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const noteDay  = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const todayDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffDays = Math.floor((todayDay.getTime() - noteDay.getTime()) / 86_400_000)
  if (diffDays === 0) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const FILTERS: { label: string; value: NoteFilterView }[] = [
  { label: 'All', value: 'all' },
  { label: 'Untagged', value: 'untagged' },
  { label: 'Tagged', value: 'tagged' }
]

interface NoteCardProps {
  note: Note
  index: number
  isActive: boolean
  isSelected: boolean
  bulkMode: boolean
  onCardClick: (note: Note) => void
  onCheckbox: (e: React.MouseEvent, note: Note, index: number) => void
}

const NoteCard = memo(function NoteCard({ note, index, isActive, isSelected, bulkMode, onCardClick, onCheckbox }: NoteCardProps) {
  const title = note.title ||
    stripMarkdownPreview(note.content.split('\n').find(l => l.trim()) || '') ||
    ''
  return (
    <div
      className={`${styles.noteCard} ${isActive ? styles.noteCardActive : ''} ${isSelected ? styles.noteCardSelected : ''}`}
      onClick={() => onCardClick(note)}
    >
      {bulkMode && (
        <label
          className={styles.noteCheckbox}
          onClick={(e) => onCheckbox(e, note, index)}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => {/* handled by label onClick */}}
          />
        </label>
      )}
      <div className={styles.noteContent}>
        <div className={styles.noteTitle}>
          {note.isPinned && <span className={styles.pinnedIcon}>📌</span>}
          {title || <span className={styles.noteUntitled}>Untitled</span>}
        </div>
        <div className={styles.noteDate}>{formatTime(note.updatedAt)}</div>
      </div>
    </div>
  )
})

export default function Notes() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(() => searchParams.get('q') ?? '')
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({})

  // Three-pane: selected note
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    () => searchParams.get('note') ?? null
  )

  // Derived from URL params
  const filter = (searchParams.get('filter') ?? 'all') as NoteFilterView
  const selectedFolder = searchParams.get('folder') ?? null
  const selectedImportSource = searchParams.get('importSource') ?? null
  const showMeetingNotes = searchParams.get('meetingNotes') === '1'

  // Folder sidebar state
  const [folders, setFolders] = useState<string[]>([])
  const [importSources, setImportSources] = useState<string[]>([])
  const [folderTagSuggestions, setFolderTagSuggestions] = useState<Map<string, TagSuggestion>>(new Map())

  // Bulk select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkPicker, setBulkPicker] = useState<'company' | 'contact' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [undoData, setUndoData] = useState<Note[] | null>(null)
  const lastCheckedRef = useRef<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const companyPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  const contactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST)

  // Panel resize for the note list (middle pane)
  const { leftWidth: listPaneWidth, dividerProps: resizeDividerProps } = usePanelResize({
    defaultWidth: 280,
    minWidth: 200,
    maxWidth: 500,
  })

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(t)
  }, [searchQuery])

  const fetchFolderData = useCallback(async () => {
    try {
      const [folderList, sourceList] = await Promise.all([
        api.invoke<string[]>(IPC_CHANNELS.NOTES_LIST_FOLDERS),
        api.invoke<string[]>(IPC_CHANNELS.NOTES_LIST_IMPORT_SOURCES),
      ])
      setFolders(folderList)
      setImportSources(sourceList)
    } catch { /* non-fatal */ }
  }, [showMeetingNotes])

  const fetchFolderCounts = useCallback(async () => {
    try {
      const rows = await api.invoke<{ folderPath: string | null; count: number }[]>(
        IPC_CHANNELS.NOTES_FOLDER_COUNTS,
        { hideClaimedMeetingNotes: !showMeetingNotes }
      )
      const map: Record<string, number> = { __all__: 0 }
      for (const row of rows) {
        const key = row.folderPath ?? INBOX_SENTINEL
        map[key] = row.count
        map['__all__'] = (map['__all__'] ?? 0) + row.count
      }
      setFolderCounts(map)
    } catch { /* non-fatal — no count badges */ }
  }, [])

  useEffect(() => {
    void Promise.all([fetchFolderData(), fetchFolderCounts()])
  }, [fetchFolderData, fetchFolderCounts])

  // Listen for folder tag suggestions from post-import background pass
  useEffect(() => {
    const off = api.on(
      IPC_CHANNELS.NOTES_FOLDER_TAG_SUGGESTION,
      (_event: unknown, { folderPath, suggestion }: { folderPath: string; suggestion: TagSuggestion }) => {
        setFolderTagSuggestions(prev => new Map(prev).set(folderPath, suggestion))
      }
    )
    return off
  }, [])

  const fetchNotes = useCallback(async () => {
    setLoading(true)
    try {
      const opts: {
        filter?: NoteFilterView
        query?: string
        folderPath?: string | null
        hideClaimedMeetingNotes?: boolean
      } = {
        filter,
        query: debouncedQuery || undefined,
        folderPath: selectedFolder,
        hideClaimedMeetingNotes: !showMeetingNotes,
      }
      const results = await api.invoke<Note[]>(IPC_CHANNELS.NOTES_LIST, opts)
      const filtered = selectedImportSource
        ? results.filter(n => n.importSource === selectedImportSource)
        : results
      setNotes(filtered)
    } catch {
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [filter, debouncedQuery, selectedFolder, selectedImportSource, showMeetingNotes])

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

  // --- Note selection ---

  const handleCardClick = useCallback((note: Note) => {
    if (selectedIds.size > 0) {
      // In bulk select mode, card click toggles selection
      const next = new Set(selectedIds)
      if (next.has(note.id)) next.delete(note.id)
      else next.add(note.id)
      setSelectedIds(next)
    } else {
      setSelectedNoteId(note.id)
      setSearchParams(prev => { prev.set('note', note.id); return prev }, { replace: true })
    }
  }, [selectedIds, setSearchParams])

  // ↑↓ keyboard navigation in list pane
  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const idx = notes.findIndex(n => n.id === selectedNoteId)
    const next = e.key === 'ArrowDown'
      ? Math.min(idx + 1, notes.length - 1)
      : Math.max(idx - 1, 0)
    if (notes[next]) {
      setSelectedNoteId(notes[next].id)
      setSearchParams(prev => { prev.set('note', notes[next].id); return prev }, { replace: true })
    }
  }, [notes, selectedNoteId, setSearchParams])

  // --- New note ---

  const handleNewNote = useCallback(async () => {
    try {
      const note = await api.invoke<Note>(IPC_CHANNELS.NOTES_CREATE, {
        content: '',
        title: null,
        folderPath: selectedFolder ?? undefined,
      })
      if (note) {
        setNotes(prev => [note, ...prev])
        setSelectedNoteId(note.id)
        setSearchParams(prev => { prev.set('note', note.id); return prev }, { replace: true })
        void fetchFolderCounts()
      }
    } catch {
      showToast('Failed to create note')
    }
  }, [selectedFolder, fetchFolderCounts, setSearchParams, showToast])

  // Cmd+N shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        void handleNewNote()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleNewNote])

  // --- Note update/delete callbacks (from NotePaneEditor) ---

  const handleNoteUpdated = useCallback((updated: Note) => {
    setNotes(prev => prev.map(n => n.id === updated.id ? updated : n))
  }, [])

  const handleNoteDeleted = useCallback((noteId: string) => {
    setNotes(prev => prev.filter(n => n.id !== noteId))
    setSelectedNoteId(prev => prev === noteId ? null : prev)
    setSearchParams(prev => { prev.delete('note'); return prev }, { replace: true })
    void fetchFolderCounts()
  }, [fetchFolderCounts, setSearchParams])

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
    if (selectedNoteId && deletedIds.has(selectedNoteId)) {
      setSelectedNoteId(null)
      setSearchParams(prev => { prev.delete('note'); return prev }, { replace: true })
    }
    setSelectedIds(new Set())
    lastCheckedRef.current = null

    setUndoData(toDelete.filter((_, i) => results[i].status === 'fulfilled'))
    if (failed === 0) {
      showToast(`Deleted ${succeeded} note${succeeded !== 1 ? 's' : ''} · Undo`)
    } else {
      showToast(`${succeeded} deleted · ${failed} failed`)
    }
  }, [selectedIds, notes, showToast, selectedNoteId, setSearchParams])

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

  // --- Folder suggestion handlers ---

  const handleDismissSuggestion = useCallback((folderPath: string) => {
    setFolderTagSuggestions(prev => {
      const next = new Map(prev)
      next.delete(folderPath)
      return next
    })
  }, [])

  const handleAcceptSuggestion = useCallback(async (folderPath: string, suggestion: TagSuggestion) => {
    const notesInFolder = await api.invoke<Note[]>(IPC_CHANNELS.NOTES_LIST, { folderPath })
    const field = suggestion.companyId ? 'companyId' : 'contactId'
    const value = (suggestion.companyId ?? suggestion.contactId)!
    await Promise.allSettled(
      notesInFolder
        .filter(n => !n.companyId && !n.contactId)
        .map(n => api.invoke(IPC_CHANNELS.NOTES_UPDATE, n.id, { [field]: value }))
    )
    handleDismissSuggestion(folderPath)
    void fetchNotes()
  }, [handleDismissSuggestion, fetchNotes])

  // --- Sidebar folder/filter handlers ---

  const handleFolderSelect = useCallback((path: string | null) => {
    if (path === INBOX_SENTINEL) {
      setSearchParams(prev => {
        prev.set('filter', 'unfoldered')
        prev.delete('folder')
        prev.delete('importSource')
        return prev
      })
    } else {
      setSearchParams(prev => {
        if (path) prev.set('folder', path)
        else prev.delete('folder')
        prev.delete('filter')
        prev.delete('importSource')
        return prev
      })
    }
  }, [setSearchParams])

  const handleSelectImportSource = useCallback((source: string | null) => {
    setSearchParams(prev => {
      if (source) prev.set('importSource', source)
      else prev.delete('importSource')
      prev.delete('folder')
      return prev
    })
  }, [setSearchParams])

  const handleSetFilter = useCallback((f: NoteFilterView) => {
    setSearchParams(prev => {
      if (f === 'all') prev.delete('filter')
      else prev.set('filter', f)
      return prev
    })
  }, [setSearchParams])

  const handleToggleMeetingNotes = useCallback(() => {
    setSearchParams(prev => {
      if (showMeetingNotes) prev.delete('meetingNotes')
      else prev.set('meetingNotes', '1')
      return prev
    })
  }, [setSearchParams, showMeetingNotes])

  // --- Folder CRUD handlers ---

  const handleCreateFolder = useCallback(async (folderPath: string) => {
    try {
      await api.invoke(IPC_CHANNELS.NOTES_FOLDER_CREATE, folderPath)
      void fetchFolderData()
    } catch (err) {
      console.error('Failed to create folder', err)
    }
  }, [fetchFolderData])

  const handleRenameFolder = useCallback(async (oldPath: string, newPath: string) => {
    try {
      await api.invoke(IPC_CHANNELS.NOTES_FOLDER_RENAME, oldPath, newPath)
      if (selectedFolder === oldPath) {
        setSearchParams(prev => {
          prev.set('folder', newPath)
          return prev
        })
      }
      void fetchFolderData()
      void fetchNotes()
    } catch (err) {
      console.error('Failed to rename folder', err)
    }
  }, [fetchFolderData, fetchNotes, selectedFolder, setSearchParams])

  const handleDeleteFolder = useCallback(async (folderPath: string) => {
    try {
      await api.invoke(IPC_CHANNELS.NOTES_FOLDER_DELETE, folderPath)
      if (selectedFolder === folderPath) {
        setSearchParams(prev => {
          prev.delete('folder')
          return prev
        })
      }
      void fetchFolderData()
      void fetchNotes()
    } catch (err) {
      console.error('Failed to delete folder', err)
    }
  }, [fetchFolderData, fetchNotes, selectedFolder, setSearchParams])

  // --- Bulk selection helpers ---

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

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === notes.length && notes.length > 0) {
      setSelectedIds(new Set())
      lastCheckedRef.current = null
    } else {
      setSelectedIds(new Set(notes.map(n => n.id)))
    }
  }, [selectedIds.size, notes])

  // Escape / Delete shortcuts
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

  // --- Render helpers ---

  const isEmpty = !loading && notes.length === 0
  const isSearching = debouncedQuery.trim().length > 0
  const allSelected = notes.length > 0 && selectedIds.size === notes.length

  // Date-grouped note list
  let lastGroup = ''

  return (
    <div className={styles.container}>
      <div className={styles.body}>
        {/* Left: folder sidebar */}
        <FolderSidebar
          folders={folders}
          selected={selectedFolder}
          isInboxActive={filter === 'unfoldered'}
          onSelect={handleFolderSelect}
          tagSuggestions={folderTagSuggestions}
          onDismissSuggestion={handleDismissSuggestion}
          onAcceptSuggestion={(fp, s) => void handleAcceptSuggestion(fp, s)}
          importSources={importSources}
          selectedImportSource={selectedImportSource}
          onSelectImportSource={handleSelectImportSource}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          counts={folderCounts}
        />

        {/* Middle: note list pane */}
        <div
          className={styles.listPane}
          style={{ width: listPaneWidth }}
          onKeyDown={handleListKeyDown}
          tabIndex={0}
        >
          {/* List header */}
          <div className={styles.listHeader}>
            <span className={styles.listTitle}>
              {selectedFolder
                ? selectedFolder.split('/').pop()
                : filter === 'unfoldered'
                ? 'Inbox'
                : selectedImportSource
                ? selectedImportSource
                : 'All Notes'}
              {(() => {
                const countKey = selectedFolder ?? (filter === 'unfoldered' ? INBOX_SENTINEL : '__all__')
                const count = folderCounts[countKey]
                return count != null ? (
                  <span className={styles.listCount}>{count}</span>
                ) : null
              })()}
            </span>
            <button
              onClick={() => void handleNewNote()}
              className={styles.newNoteBtn}
              title="New note (⌘N)"
            >
              +
            </button>
          </div>

          {/* Search */}
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

          {/* Filter chips / bulk bar */}
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
            !searchQuery && filter !== 'unfoldered' && !selectedFolder && (
              <div className={styles.filterBar}>
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    className={`${styles.filterChip} ${filter === f.value ? styles.filterChipActive : ''}`}
                    onClick={() => handleSetFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
                <button
                  className={`${styles.meetingToggle} ${showMeetingNotes ? styles.meetingToggleActive : ''}`}
                  onClick={handleToggleMeetingNotes}
                  title={showMeetingNotes ? 'Hiding meeting notes from companies' : 'Meeting notes from companies are hidden'}
                >
                  + Meetings
                </button>
              </div>
            )
          )}

          {/* Note list */}
          <div className={styles.list}>
            {isEmpty ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>📝</div>
                <div className={styles.emptyTitle}>
                  {isSearching
                    ? 'No notes match your search'
                    : filter === 'unfoldered'
                    ? 'Inbox is empty'
                    : selectedFolder
                    ? `No notes in "${selectedFolder.split('/').pop()}"`
                    : filter === 'all'
                    ? 'No notes yet'
                    : `No ${filter} notes`}
                </div>
                <div className={styles.emptyDesc}>
                  {isSearching
                    ? 'Try a different search term.'
                    : filter === 'unfoldered'
                    ? 'All your notes are assigned to a folder.'
                    : filter === 'all'
                    ? 'Press + or ⌘N to capture a thought.'
                    : filter === 'untagged'
                    ? 'All your notes are tagged to a company or contact.'
                    : 'Tag a note to a company or contact to see it here.'}
                </div>
              </div>
            ) : (
              notes.map((note, index) => {
                const group = getDateGroup(note.updatedAt)
                const showHeader = !debouncedQuery && group !== lastGroup
                lastGroup = group

                return (
                  <div key={note.id}>
                    {showHeader && (
                      <div className={styles.dateGroupHeader}>{group}</div>
                    )}
                    <NoteCard
                      note={note}
                      index={index}
                      isActive={selectedNoteId === note.id}
                      isSelected={selectedIds.has(note.id)}
                      bulkMode={selectedIds.size > 0}
                      onCardClick={handleCardClick}
                      onCheckbox={handleCheckbox}
                    />
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Resize handle */}
        <div className={styles.resizeHandle} {...resizeDividerProps} />

        {/* Right: detail pane */}
        <div className={styles.detailPane}>
          <NotePaneEditor
            noteId={selectedNoteId}
            onNoteUpdated={handleNoteUpdated}
            onNoteDeleted={handleNoteDeleted}
          />
        </div>
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
