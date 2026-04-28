/**
 * ViewsBar — entity-agnostic saved views header + dropdown.
 *
 * Displays the active view name as a page-level heading with a dropdown
 * chevron. Clicking opens a menu with "All {entity}" plus all saved views.
 * Includes inline save + delete.
 *
 * Drift detection:
 *   - "active" item: current state exactly matches saved view
 *   - "drifted" item: this was the last-applied view but state has since changed
 *
 * normalizeParams() produces a stable, sorted string from URLSearchParams
 * so equivalent param sets compare equal regardless of insertion order.
 *
 * Storage format (localStorage):
 *   SavedView[] JSON, keyed by storageKey prop.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import styles from './ViewsBar.module.css'

export interface SavedView {
  id: string           // crypto.randomUUID()
  name: string
  urlParams: string    // normalizeParams() output — stable, sorted
  columns: string[]    // visibleKeys snapshot
}

export interface ViewsBarHandle {
  openSave: () => void
}

interface ViewsBarProps {
  storageKey: string                  // 'cyggie:company-views' | 'cyggie:contact-views'
  currentParams: URLSearchParams
  currentColumns: string[]
  defaultColumns: string[]            // columns to restore when switching to "All"
  onApply: (params: URLSearchParams, columns: string[]) => void
  hideSaveButton?: boolean
  entityLabel?: string                // e.g. "Companies", "Contacts" — used as "All {label}"
}

/**
 * Normalize URLSearchParams to a stable string for drift comparison.
 * Sorts keys alphabetically, sorts multi-values within each key.
 */
export function normalizeParams(params: {
  keys?: () => IterableIterator<string>
  getAll(key: string): string[]
  forEach?: (cb: (value: string, key: string) => void) => void
}): string {
  const keys = (() => {
    if (typeof params.keys === 'function') {
      return [...new Set(params.keys())]
    }
    if (typeof params.forEach === 'function') {
      const set = new Set<string>()
      params.forEach((_value, key) => set.add(key))
      return [...set]
    }
    return []
  })().sort()
  return keys
    .flatMap((k) => params.getAll(k).sort().map((v) => `${k}=${v}`))
    .join('&')
}

function normalizeViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return []
  const views: SavedView[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : null
    const name = typeof record.name === 'string' ? record.name : null
    const urlParams = typeof record.urlParams === 'string' ? record.urlParams : null
    if (!id || !name || urlParams == null) continue
    const columnsRaw = record.columns
    const columns = Array.isArray(columnsRaw)
      ? columnsRaw.filter((col) => typeof col === 'string')
      : []
    views.push({ id, name, urlParams, columns })
  }
  return views
}

function loadViews(storageKey: string): SavedView[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    return normalizeViews(JSON.parse(raw))
  } catch {
    console.warn(`[ViewsBar] Failed to parse saved views (${storageKey})`)
    return []
  }
}

function persistViews(storageKey: string, views: SavedView[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(storageKey, JSON.stringify(views))
  } catch {
    console.warn(`[ViewsBar] Failed to save views (${storageKey}) — storage quota exceeded?`)
  }
}

export const ViewsBar = forwardRef<ViewsBarHandle, ViewsBarProps>(function ViewsBar(
  { storageKey, currentParams, currentColumns, defaultColumns, onApply, hideSaveButton, entityLabel },
  ref
) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews(storageKey))
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [lastAppliedId, setLastAppliedId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const saveInputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    openSave: () => { setSaveOpen(true); setDropdownOpen(true) }
  }), [])

  // Reload views when storageKey changes
  useEffect(() => {
    setViews(loadViews(storageKey))
    setLastAppliedId(null)
  }, [storageKey])

  // Click-outside to close
  useEffect(() => {
    if (!dropdownOpen) return
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setSaveOpen(false)
        setSaveName('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [dropdownOpen])

  useEffect(() => {
    if (saveOpen) saveInputRef.current?.focus()
  }, [saveOpen])

  const normalizedCurrent = normalizeParams(currentParams)
  const currentColStr = currentColumns.join(',')
  const allLabel = entityLabel ? `All ${entityLabel}` : 'All'

  function isViewActive(view: SavedView): boolean {
    return view.urlParams === normalizedCurrent && view.columns.join(',') === currentColStr
  }

  function isViewDrifted(view: SavedView): boolean {
    return lastAppliedId === view.id && !isViewActive(view)
  }

  const activeView = views.find(isViewActive)
  const driftedView = !activeView ? views.find(isViewDrifted) : null
  const hasParams = normalizedCurrent !== ''
  const headerLabel = activeView?.name
    ?? driftedView?.name
    ?? (hasParams ? `${allLabel} (filtered)` : allLabel)

  function applyView(view: SavedView) {
    const params = new URLSearchParams()
    const pairs = (view.urlParams || '').split('&')
    for (const pair of pairs) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      params.append(pair.slice(0, eq), pair.slice(eq + 1))
    }
    setLastAppliedId(view.id)
    onApply(params, view.columns)
    setDropdownOpen(false)
  }

  function applyAll() {
    setLastAppliedId(null)
    onApply(new URLSearchParams(), defaultColumns)
    setDropdownOpen(false)
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
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `view-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const view: SavedView = {
      id,
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
    <div className={styles.viewsBar} ref={dropdownRef}>
      {/* Header title — shows active view name */}
      <button
        className={`${styles.viewsHeader} ${dropdownOpen ? styles.viewsHeaderOpen : ''}`}
        onClick={() => setDropdownOpen((v) => !v)}
      >
        <h2 className={styles.viewsTitle}>{headerLabel}</h2>
        <span className={styles.viewsChevron}>{dropdownOpen ? '▴' : '▾'}</span>
      </button>

      {/* Dropdown menu */}
      {dropdownOpen && (
        <div className={styles.viewsDropdown}>
          {/* "All" default */}
          <button
            className={`${styles.viewsItem} ${!activeView && !driftedView ? styles.viewsItemActive : ''}`}
            onClick={applyAll}
          >
            {allLabel}
          </button>

          {views.length > 0 && <div className={styles.viewsDivider} />}

          {/* Saved views */}
          {views.map((view) => {
            const active = isViewActive(view)
            const drifted = isViewDrifted(view)
            return (
              <div
                key={view.id}
                className={`${styles.viewsItem} ${active ? styles.viewsItemActive : ''} ${drifted ? styles.viewsItemDrifted : ''}`}
                onClick={() => applyView(view)}
              >
                {drifted && <span className={styles.driftDot} />}
                <span className={styles.viewsItemLabel}>{view.name}</span>
                <button
                  className={styles.viewsItemX}
                  onClick={(e) => { e.stopPropagation(); deleteView(view.id) }}
                  title="Remove view"
                >
                  ×
                </button>
              </div>
            )
          })}

          {/* Save current view */}
          {!hideSaveButton && (
            <>
              <div className={styles.viewsDivider} />
              {saveOpen ? (
                <div className={styles.saveRow}>
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
              ) : (
                <button
                  className={styles.viewsItem}
                  onClick={() => setSaveOpen(true)}
                >
                  ★ Save current view
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})
