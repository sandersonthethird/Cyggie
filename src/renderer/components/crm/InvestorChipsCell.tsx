/**
 * InvestorChipsCell — table cell for investor relationship lists.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ STATE MACHINE                                          │
 *   │                                                        │
 *   │   idle ─dblclick─▶ editing ─Esc/blur/Enter(empty)──▶ idle │
 *   │                       │                                │
 *   │                       ├─Enter(typed close fuzzy)─▶ dedupConfirm  │
 *   │                       │                                │
 *   │                  dedupConfirm ─[Use existing | Create]─▶ editing │
 *   │                       │                                │
 *   │                       └─paste──▶ pendingChips (serial)  │
 *   └────────────────────────────────────────────────────────┘
 *
 * The popover renders via React Portal anchored to the cell, with rAF-throttled
 * scroll repositioning on the table viewport.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useInvestorChips, type InvestorEntry } from '../../hooks/useInvestorChips'
import { CompanyChip } from '../common/CompanyChip'
import type { CompanySummary } from '../../../shared/types/company'
import styles from './InvestorChipsCell.module.css'

const POPOVER_WIDTH = 360

interface InvestorChipsCellProps {
  value: Array<{ id: string; name: string; domain: string | null }>
  /** Called when user closes the editor with a changed list. */
  onSave: (next: InvestorEntry[]) => Promise<void> | void
  isEditing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  /** Optional ref to the table scroll container for reposition-on-scroll. */
  scrollContainer?: HTMLElement | null
  readOnly?: boolean
  /** Limit number of chips. When set to 1, adding evicts the existing chip (auto-replace). */
  maxChips?: number
}

interface PopoverPos {
  top: number
  left: number
}

interface PendingChip {
  /** Stable client-only id while the chip is resolving. */
  tempId: string
  name: string
}

interface DedupCandidate {
  typed: string
  match: CompanySummary
}

function chipsEqual(a: InvestorEntry[], b: InvestorEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
  }
  return true
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function InvestorChipsCell({
  value,
  onSave,
  isEditing,
  onStartEdit,
  onEndEdit,
  scrollContainer,
  readOnly = false,
  maxChips,
}: InvestorChipsCellProps) {
  const navigate = useNavigate()
  const cellRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const { suggestions, search, findOrCreate, parseList, fuzzyMatch } = useInvestorChips()

  const [chips, setChips] = useState<InvestorEntry[]>(() =>
    value.map((v) => ({ id: v.id, name: v.name, domain: v.domain }))
  )
  const [pending, setPending] = useState<PendingChip[]>([])
  const [input, setInput] = useState('')
  const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null)
  const [dedupCandidate, setDedupCandidate] = useState<DedupCandidate | null>(null)
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const closingRef = useRef(false)

  // Sync chips when value changes from outside (e.g. external save) and we're not editing.
  useEffect(() => {
    if (!isEditing) {
      setChips(value.map((v) => ({ id: v.id, name: v.name, domain: v.domain })))
    }
  }, [value, isEditing])

  // ── Position calc ──────────────────────────────────────────────────────────
  const recomputePosition = useCallback(() => {
    const cell = cellRef.current
    if (!cell) return
    const rect = cell.getBoundingClientRect()
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth
    const popoverH = popoverRef.current?.getBoundingClientRect().height ?? 280

    let top = rect.bottom + 4
    if (top + popoverH > viewportH - 8) {
      top = Math.max(8, rect.top - popoverH - 4)
    }
    let left = rect.left
    if (left + POPOVER_WIDTH > viewportW - 8) {
      left = Math.max(8, viewportW - POPOVER_WIDTH - 8)
    }
    setPopoverPos({ top, left })
  }, [])

  // Recompute on open + on scroll (rAF-throttled)
  useLayoutEffect(() => {
    if (!isEditing) {
      setPopoverPos(null)
      return
    }
    recomputePosition()
  }, [isEditing, recomputePosition])

  useEffect(() => {
    if (!isEditing) return
    let frame: number | null = null
    const handleScroll = () => {
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        recomputePosition()
      })
    }
    window.addEventListener('scroll', handleScroll, true)
    scrollContainer?.addEventListener('scroll', handleScroll)
    window.addEventListener('resize', handleScroll)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', handleScroll, true)
      scrollContainer?.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [isEditing, scrollContainer, recomputePosition])

  // Autofocus input on open
  useEffect(() => {
    if (isEditing) inputRef.current?.focus()
  }, [isEditing])

  // ── Click-outside to close ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isEditing) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (popoverRef.current?.contains(target)) return
      if (cellRef.current?.contains(target)) return
      handleCommitAndClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, chips, pending])

  // ── Commit & close ─────────────────────────────────────────────────────────
  const handleCommitAndClose = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    try {
      // Drop pending — they'll resolve and self-add but we close the popover.
      // Phase 1 decision: caller chose "serial pending chips visible during paste"
      // and any chips already resolved are committed. Pending chips that haven't
      // resolved by close time are abandoned (the next paste/edit picks them up).
      if (!chipsEqual(chips, value.map((v) => ({ id: v.id, name: v.name, domain: v.domain })))) {
        await onSave(chips)
      }
    } catch (err) {
      console.error('[InvestorChipsCell] save failed:', err)
      setError(String(err))
    } finally {
      closingRef.current = false
      setInput('')
      setError(null)
      setDedupCandidate(null)
      setPending([])
      onEndEdit()
    }
  }, [chips, value, onSave, onEndEdit])

  // ── Add a chip from a resolved entry ───────────────────────────────────────
  const addChip = useCallback((entry: InvestorEntry) => {
    setChips((prev) => {
      if (prev.some((c) => c.id === entry.id)) return prev
      if (maxChips && prev.length >= maxChips) {
        // Auto-replace: drop the oldest chip(s) and append the new one.
        // Show a transient toast so the user sees what was replaced.
        const replaced = prev[prev.length - 1]
        setError(`Replaced ${replaced.name} with ${entry.name}`)
        window.setTimeout(() => setError((e) => (e === `Replaced ${replaced.name} with ${entry.name}` ? null : e)), 2000)
        return [...prev.slice(0, maxChips - 1), entry]
      }
      return [...prev, entry]
    })
  }, [maxChips])

  const removeChip = useCallback((id: string) => {
    setChips((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const reorderChips = useCallback((draggedId: string, targetId: string) => {
    setChips((prev) => {
      const fromIdx = prev.findIndex((c) => c.id === draggedId)
      const toIdx = prev.findIndex((c) => c.id === targetId)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev
      const next = prev.slice()
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
    setDraggingId(null)
    setDropTargetId(null)
  }, [])

  // ── Resolve typed input → InvestorEntry ────────────────────────────────────
  const resolveAndAdd = useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const entry = await findOrCreate(trimmed)
      addChip(entry)
    } catch (err) {
      console.error('[InvestorChipsCell] findOrCreate failed:', err)
      setError(`Couldn't add: ${trimmed}`)
    }
  }, [findOrCreate, addChip])

  // ── Paste handling — serial pending chips ──────────────────────────────────
  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    // Only intercept when the paste contains delimiters (multi-name paste)
    if (!/[,;\n\t]/.test(text)) return
    e.preventDefault()
    const { names, clamped } = parseList(text, chips)
    if (names.length === 0) return
    if (clamped) setError('Pasted list trimmed to 25 names')

    // Add all as pending immediately, resolve serially.
    const pendingItems: PendingChip[] = names.map((name, i) => ({
      tempId: `pending-${Date.now()}-${i}`,
      name,
    }))
    setPending(pendingItems)
    setInput('')

    for (const item of pendingItems) {
      try {
        const entry = await findOrCreate(item.name)
        setPending((prev) => prev.filter((p) => p.tempId !== item.tempId))
        addChip(entry)
      } catch (err) {
        console.error('[InvestorChipsCell] paste resolve failed:', item.name, err)
        setPending((prev) => prev.filter((p) => p.tempId !== item.tempId))
        setError(`Couldn't add: ${item.name}`)
      }
    }
  }, [chips, parseList, findOrCreate, addChip])

  // ── Search effect ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isEditing) return
    search(input)
    setActiveSuggestionIdx(0)
  }, [input, isEditing, search])

  // ── Filter suggestions (drop already-added) ────────────────────────────────
  const filteredSuggestions = useMemo(
    () => suggestions.filter((s) => !chips.some((c) => c.id === s.id)),
    [suggestions, chips]
  )

  // ── Commit current input as a chip ─────────────────────────────────────────
  const commitInput = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    // 1) Exact normalized match → use existing without confirm
    const exact = filteredSuggestions.find((s) => normalizeName(s.canonicalName) === normalizeName(trimmed))
    if (exact) {
      addChip({ id: exact.id, name: exact.canonicalName, domain: exact.primaryDomain ?? null })
      setInput('')
      return
    }

    // 2) Fuzzy match → confirm
    const fuzzy = fuzzyMatch(trimmed, filteredSuggestions)
    if (fuzzy) {
      setDedupCandidate({ typed: trimmed, match: fuzzy })
      return
    }

    // 3) No match → find-or-create
    await resolveAndAdd(trimmed)
    setInput('')
  }, [input, filteredSuggestions, addChip, fuzzyMatch, resolveAndAdd])

  // ── Keyboard handling ──────────────────────────────────────────────────────
  const handleKeyDown = useCallback(async (e: KeyboardEvent<HTMLInputElement>) => {
    if (dedupCandidate) return // dedup overlay handles its own keys

    if (e.key === 'Enter') {
      e.preventDefault()
      if (!input.trim()) {
        // Empty input + Enter → close
        handleCommitAndClose()
        return
      }
      // If user navigated to a specific suggestion, pick that
      if (filteredSuggestions[activeSuggestionIdx] && activeSuggestionIdx < filteredSuggestions.length) {
        const sel = filteredSuggestions[activeSuggestionIdx]
        // Only auto-pick suggestion if it's a clear match (top hit) — otherwise commitInput's
        // logic decides between exact/fuzzy/create.
        const isTopHit = activeSuggestionIdx === 0 && filteredSuggestions.length > 0
        if (isTopHit && input.trim().length >= 3 && normalizeName(sel.canonicalName).startsWith(normalizeName(input.trim()))) {
          addChip({ id: sel.id, name: sel.canonicalName, domain: sel.primaryDomain ?? null })
          setInput('')
          return
        }
      }
      await commitInput()
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      if (input.trim()) await commitInput()
      handleCommitAndClose()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      handleCommitAndClose()
      return
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && input === '' && chips.length > 0) {
      e.preventDefault()
      setChips((prev) => prev.slice(0, -1))
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestionIdx((i) => Math.min(filteredSuggestions.length - 1, i + 1))
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestionIdx((i) => Math.max(0, i - 1))
      return
    }
  }, [
    dedupCandidate, input, chips, filteredSuggestions, activeSuggestionIdx,
    handleCommitAndClose, commitInput, addChip,
  ])

  // ── Dedup confirm handlers ─────────────────────────────────────────────────
  const acceptDedup = useCallback(() => {
    if (!dedupCandidate) return
    addChip({
      id: dedupCandidate.match.id,
      name: dedupCandidate.match.canonicalName,
      domain: dedupCandidate.match.primaryDomain ?? null,
    })
    setDedupCandidate(null)
    setInput('')
    inputRef.current?.focus()
  }, [dedupCandidate, addChip])

  const rejectDedup = useCallback(async () => {
    if (!dedupCandidate) return
    const typed = dedupCandidate.typed
    setDedupCandidate(null)
    await resolveAndAdd(typed)
    setInput('')
    inputRef.current?.focus()
  }, [dedupCandidate, resolveAndAdd])

  // ── Read-mode click handlers ───────────────────────────────────────────────
  const handleChipClick = useCallback((id: string) => {
    navigate(`/company/${id}`, { state: { backLabel: 'Companies' } })
  }, [navigate])

  // ── Render ─────────────────────────────────────────────────────────────────
  const popoverContent = isEditing && popoverPos ? (
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{ top: popoverPos.top, left: popoverPos.left, width: POPOVER_WIDTH }}
      // Stop both mousedown AND click. The popover renders via React Portal but
      // synthetic events still bubble through the React tree to the cell wrapper's
      // onClick (handleFocusCell), which calls setEditCell(null) and would close
      // the popover the moment the user clicks the input inside it.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.popoverChips}>
        {chips.map((chip) => (
          <CompanyChip
            key={chip.id}
            id={chip.id}
            name={chip.name}
            domain={chip.domain}
            onClickName={handleChipClick}
            onRemove={removeChip}
            testId={`chip-${chip.id}`}
            draggable
            onDragStart={setDraggingId}
            onDragOver={setDropTargetId}
            onDrop={reorderChips}
            onDragEnd={() => { setDraggingId(null); setDropTargetId(null) }}
            isDragging={draggingId === chip.id}
            isDropTarget={dropTargetId === chip.id && draggingId !== chip.id}
          />
        ))}
        {pending.map((p) => (
          <CompanyChip
            key={p.tempId}
            id={p.tempId}
            name={p.name}
            pending
            testId={`pending-${p.tempId}`}
          />
        ))}
      </div>

      {dedupCandidate ? (
        <div className={styles.dedupConfirm}>
          <div className={styles.dedupQuestion}>
            Did you mean <strong>{dedupCandidate.match.canonicalName}</strong>?
          </div>
          <div className={styles.dedupActions}>
            <button type="button" className={styles.dedupBtn} onClick={rejectDedup}>
              Create as &ldquo;{dedupCandidate.typed}&rdquo;
            </button>
            <button
              type="button"
              className={`${styles.dedupBtn} ${styles.dedupBtnPrimary}`}
              onClick={acceptDedup}
            >
              Use existing
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            className={styles.popoverInput}
            type="text"
            placeholder="Type a company or paste a list…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            disabled={pending.length > 0}
          />
          <div className={styles.popoverHint}>
            Enter to add · Backspace removes last · Esc to close
          </div>
          {filteredSuggestions.length > 0 && (
            <ul className={styles.suggestionList}>
              {filteredSuggestions.slice(0, 8).map((s, idx) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`${styles.suggestionItem} ${idx === activeSuggestionIdx ? styles.active : ''}`}
                    onMouseEnter={() => setActiveSuggestionIdx(idx)}
                    onClick={() => {
                      addChip({ id: s.id, name: s.canonicalName, domain: s.primaryDomain ?? null })
                      setInput('')
                      inputRef.current?.focus()
                    }}
                  >
                    {s.canonicalName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && <div className={styles.toastSlot}>{error}</div>}
    </div>
  ) : null

  // ── Read mode ──────────────────────────────────────────────────────────────
  const visibleChips = chips.slice(0, 3)
  const hiddenCount = chips.length - visibleChips.length

  return (
    <>
      <div
        ref={cellRef}
        className={styles.cell}
        onDoubleClick={() => {
          if (readOnly) return
          onStartEdit()
        }}
      >
        {chips.length === 0 ? (
          <span className={styles.cellEmpty}>—</span>
        ) : (
          <div className={styles.chipRow}>
            {visibleChips.map((chip) => (
              <CompanyChip
                key={chip.id}
                id={chip.id}
                name={chip.name}
                domain={chip.domain}
                onClickName={handleChipClick}
                readOnly
                testId={`chip-read-${chip.id}`}
              />
            ))}
            {hiddenCount > 0 && (
              <span className={styles.moreCount}>+{hiddenCount} more</span>
            )}
          </div>
        )}
      </div>
      {popoverContent && createPortal(popoverContent, document.body)}
    </>
  )
}
