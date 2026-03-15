/**
 * ViewsBar — entity-agnostic saved views chip bar.
 *
 * Shows named filter+sort+column combos as chips.
 * Lives between the scope tabs and the filter chips row.
 *
 * Drift detection:
 *   - "active" chip: current state exactly matches saved view
 *   - "drifted" chip: this was the last-applied view but state has since changed
 *
 * normalizeParams() produces a stable, sorted string from URLSearchParams
 * so equivalent param sets compare equal regardless of insertion order.
 *
 * Storage format (localStorage):
 *   SavedView[] JSON, keyed by storageKey prop.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReadonlyURLSearchParams } from 'react-router-dom'
import styles from './ViewsBar.module.css'

export interface SavedView {
  id: string           // crypto.randomUUID()
  name: string
  urlParams: string    // normalizeParams() output — stable, sorted
  columns: string[]    // visibleKeys snapshot
}

interface ViewsBarProps {
  storageKey: string                  // 'cyggie:company-views' | 'cyggie:contact-views'
  currentParams: ReadonlyURLSearchParams
  currentColumns: string[]
  onApply: (params: URLSearchParams, columns: string[]) => void
}

/**
 * Normalize URLSearchParams to a stable string for drift comparison.
 * Sorts keys alphabetically, sorts multi-values within each key.
 */
export function normalizeParams(params: { keys(): IterableIterator<string>; getAll(key: string): string[] }): string {
  const keys = [...new Set(params.keys())].sort()
  return keys
    .flatMap((k) => params.getAll(k).sort().map((v) => `${k}=${v}`))
    .join('&')
}

function loadViews(storageKey: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    return JSON.parse(raw) as SavedView[]
  } catch {
    console.warn(`[ViewsBar] Failed to parse saved views (${storageKey})`)
    return []
  }
}

function persistViews(storageKey: string, views: SavedView[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(views))
  } catch {
    console.warn(`[ViewsBar] Failed to save views (${storageKey}) — storage quota exceeded?`)
  }
}

export function ViewsBar({ storageKey, currentParams, currentColumns, onApply }: ViewsBarProps) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews(storageKey))
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  // Tracks which view was last applied — used to show drift indicator
  const [lastAppliedId, setLastAppliedId] = useState<string | null>(null)
  const saveRef = useRef<HTMLDivElement>(null)
  const saveInputRef = useRef<HTMLInputElement>(null)

  // Reload views when storageKey changes (switching between Company/Contact pages)
  useEffect(() => {
    setViews(loadViews(storageKey))
    setLastAppliedId(null)
  }, [storageKey])

  // Click-outside to close save popover
  useEffect(() => {
    if (!saveOpen) return
    function handle(e: MouseEvent) {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) {
        setSaveOpen(false)
        setSaveName('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [saveOpen])

  useEffect(() => {
    if (saveOpen) saveInputRef.current?.focus()
  }, [saveOpen])

  const normalizedCurrent = normalizeParams(currentParams)
  const currentColStr = currentColumns.join(',')

  function isViewActive(view: SavedView): boolean {
    return view.urlParams === normalizedCurrent && view.columns.join(',') === currentColStr
  }

  // A chip shows the drift dot if it was the last-applied view but state has since drifted
  function isViewDrifted(view: SavedView): boolean {
    return lastAppliedId === view.id && !isViewActive(view)
  }

  function applyView(view: SavedView) {
    const params = new URLSearchParams()
    for (const pair of view.urlParams.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      params.append(pair.slice(0, eq), pair.slice(eq + 1))
    }
    setLastAppliedId(view.id)
    onApply(params, view.columns)
  }

  function deleteView(id: string) {
    const next = views.filter((v) => v.id !== id)
    setViews(next)
    persistViews(storageKey, next)
    if (lastAppliedId === id) setLastAppliedId(null)
  }

  function saveCurrentView() {
    const name = saveName.trim()
    if (!name) return
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      urlParams: normalizedCurrent,
      columns: [...currentColumns]
    }
    const next = [...views, view]
    setViews(next)
    persistViews(storageKey, next)
    setSaveOpen(false)
    setSaveName('')
  }

  return (
    <div className={styles.viewsBar}>
      {/* Saved view chips */}
      {views.map((view) => {
        const active = isViewActive(view)
        const drifted = isViewDrifted(view)
        return (
          <span
            key={view.id}
            className={`${styles.viewChip} ${active ? styles.viewChipActive : ''} ${drifted ? styles.viewChipDrifted : ''}`}
            onClick={() => applyView(view)}
            title={drifted ? 'State has changed since this view was applied — click to restore' : undefined}
          >
            {drifted && <span className={styles.driftDot} />}
            {view.name}
            <button
              className={styles.viewChipX}
              onClick={(e) => { e.stopPropagation(); deleteView(view.id) }}
              title="Remove view"
            >
              ×
            </button>
          </span>
        )
      })}

      {/* Save view button + popover */}
      <div ref={saveRef} className={styles.saveWrap}>
        <button
          className={`${styles.saveBtn} ${saveOpen ? styles.saveBtnActive : ''}`}
          onClick={() => setSaveOpen((v) => !v)}
        >
          ★ Save view
        </button>
        {saveOpen && (
          <div className={styles.savePopover}>
            <input
              ref={saveInputRef}
              className={styles.saveInput}
              placeholder="View name…"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveCurrentView() }
                if (e.key === 'Escape') { setSaveOpen(false); setSaveName('') }
              }}
            />
            <button
              className={styles.saveConfirmBtn}
              onClick={saveCurrentView}
              disabled={!saveName.trim()}
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
