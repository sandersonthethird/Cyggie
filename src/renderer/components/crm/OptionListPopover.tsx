/**
 * OptionListPopover — shared portal-rendered dropdown primitive.
 *
 * Consumed by:
 *   - EditableCell (Contacts/Companies table dropdown cells)
 *   - PropertyRow  (property panel single-select + multiselect)
 *   - Future "pick from a fixed option list" surfaces
 *
 * Modes:
 *   single ── commits on pick via onPick(value); Enter/click commits, Tab commits+advances
 *   multi  ── toggles selection via onMultiChange(values[]); commits on close via onCommitMulti
 *
 *                         ┌────────────────────────────────┐
 *                         │  document.body  (portal root)  │
 *                         │  ┌──────────────────────────┐  │
 *  anchorEl (cell/trigger)│  │  popover (fixed, z-pop)  │  │
 *      │      anchored by │  │  ┌────────────────────┐  │  │
 *      ▼                  │  │  │ option 1  (chip)   │  │  │
 *   ┌──────┐              │  │  │ option 2  (chip)   │  │  │
 *   │ cell │ ────────────►│  │  │ option 3  (chip)   │  │  │
 *   └──────┘              │  │  ├────────────────────┤  │  │
 *                         │  │  │ + Add option…      │  │  │
 *                         │  │  └────────────────────┘  │  │
 *                         │  └──────────────────────────┘  │
 *                         └────────────────────────────────┘
 *
 * Position: getBoundingClientRect(anchorEl), default below; flip above when
 * popover would overflow viewport bottom. Recomputed on scroll (window
 * capture + scrollContainer + resize), rAF-throttled. Pattern lifted from
 * InvestorChipsCell.tsx.
 *
 * Keyboard:
 *   ArrowUp/Down ── move highlight
 *   Enter        ── pick (single) / toggle (multi)
 *   Tab          ── pick + advance (single only, via onPickAndAdvance)
 *   Space        ── toggle (multi only)
 *   Escape       ── onClose
 *   <printable>  ── multi-char jump-to-prefix; 500ms idle resets buffer
 *
 * Add-option flow: when onAddOption is provided, "+ Add option…" appears as
 * the last item. Clicking swaps the popover body in-place (no visual jump)
 * to AddOptionInlineInput. Confirm fires onAddOptionConfirm(newOption);
 * consumer is responsible for persisting + (for single mode) picking it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AddOptionInlineInput } from './AddOptionInlineInput'
import styles from './OptionListPopover.module.css'

export interface OptionListItem {
  value: string
  label: string
}

interface OptionListPopoverProps {
  anchorEl: HTMLElement | null
  options: OptionListItem[]
  /** string for single mode, string[] for multi mode */
  value: string | string[]
  mode: 'single' | 'multi'
  onClose: () => void
  /** single mode: called when an option is picked (click or Enter) */
  onPick?: (value: string) => void
  /** single mode: called when Tab picks + advances to the next editable column */
  onPickAndAdvance?: (value: string, dir: 'right' | 'down') => void
  /** multi mode: called on each toggle with the new full selection */
  onMultiChange?: (values: string[]) => void
  /** multi mode: called when the popover closes (commits the accumulated selection) */
  onCommitMulti?: () => void
  /** If provided, "+ Add option…" appears as the last item */
  onAddOption?: () => void
  /** Called when the inline add-option input confirms a new value */
  onAddOptionConfirm?: (newOption: string) => void | Promise<void>
  /** Scroll container that contains anchorEl; used to reposition popover on scroll */
  scrollContainer?: HTMLElement | null
  /** Seeds the active highlight to the first option whose label starts with this char */
  initialChar?: string
  /** Per-option chip styling. If omitted, options render as plain text. */
  chipStyle?: (value: string) => CSSProperties
}

const POPOVER_OFFSET = 4
const TYPE_BUFFER_RESET_MS = 500

export function OptionListPopover({
  anchorEl,
  options,
  value,
  mode,
  onClose,
  onPick,
  onPickAndAdvance,
  onMultiChange,
  onCommitMulti,
  onAddOption,
  onAddOptionConfirm,
  scrollContainer,
  initialChar,
  chipStyle,
}: OptionListPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(() => {
    // Seed from initialChar if provided.
    if (initialChar) {
      const c = initialChar.toLowerCase()
      const i = options.findIndex(o => o.label.toLowerCase().startsWith(c))
      if (i >= 0) return i
    }
    // Single mode: highlight the currently-selected value (or first option if empty).
    if (mode === 'single' && typeof value === 'string') {
      const i = options.findIndex(o => o.value === value)
      return i >= 0 ? i : 0
    }
    // Multi mode: highlight the first SELECTED option. If nothing selected,
    // start at -1 so the first ArrowDown lands on index 0 (PropertyRow legacy
    // behavior — gives keyboard users a clear "wake up" moment).
    if (mode === 'multi' && Array.isArray(value) && value.length > 0) {
      const i = options.findIndex(o => value.includes(o.value))
      if (i >= 0) return i
    }
    return mode === 'multi' ? -1 : 0
  })
  const [addingOption, setAddingOption] = useState(false)
  const typeBufferRef = useRef<string>('')
  const typeBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)

  const selectedSet = useMemo(() => {
    if (mode === 'multi' && Array.isArray(value)) return new Set(value)
    return new Set<string>()
  }, [mode, value])

  // ── Position calc ────────────────────────────────────────────────────────
  const recomputePosition = useCallback(() => {
    if (!anchorEl) return
    const rect = anchorEl.getBoundingClientRect()
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth
    const popoverH = popoverRef.current?.getBoundingClientRect().height ?? 240
    const popoverW = popoverRef.current?.getBoundingClientRect().width ?? 200

    let top = rect.bottom + POPOVER_OFFSET
    if (top + popoverH > viewportH - 8) {
      top = Math.max(8, rect.top - popoverH - POPOVER_OFFSET)
    }
    let left = rect.left
    if (left + popoverW > viewportW - 8) {
      left = Math.max(8, viewportW - popoverW - 8)
    }
    setPosition({ top, left })
  }, [anchorEl])

  useLayoutEffect(() => {
    recomputePosition()
  }, [recomputePosition])

  // Reposition on scroll/resize (rAF-throttled). Lifted from InvestorChipsCell.
  useEffect(() => {
    let frame: number | null = null
    const handler = () => {
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        recomputePosition()
      })
    }
    window.addEventListener('scroll', handler, true)
    scrollContainer?.addEventListener('scroll', handler)
    window.addEventListener('resize', handler)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', handler, true)
      scrollContainer?.removeEventListener('scroll', handler)
      window.removeEventListener('resize', handler)
    }
  }, [scrollContainer, recomputePosition])

  // ── Outside-click / Esc handling ────────────────────────────────────────
  const close = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    if (mode === 'multi') onCommitMulti?.()
    onClose()
  }, [mode, onCommitMulti, onClose])

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (popoverRef.current?.contains(t)) return
      if (anchorEl?.contains(t as Node)) return
      close()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [anchorEl, close])

  // Cleanup type buffer timer on unmount
  useEffect(() => () => {
    if (typeBufferTimerRef.current != null) clearTimeout(typeBufferTimerRef.current)
  }, [])

  // ── Selection helpers ───────────────────────────────────────────────────
  const pickSingle = useCallback((picked: string) => {
    onPick?.(picked)
  }, [onPick])

  const toggleMulti = useCallback((toggled: string) => {
    if (!Array.isArray(value)) return
    const next = selectedSet.has(toggled)
      ? value.filter(v => v !== toggled)
      : [...value, toggled]
    onMultiChange?.(next)
  }, [value, selectedSet, onMultiChange])

  const handleOptionActivate = useCallback((idx: number) => {
    const opt = options[idx]
    if (!opt) return
    if (mode === 'single') pickSingle(opt.value)
    else toggleMulti(opt.value)
  }, [options, mode, pickSingle, toggleMulti])

  // ── Type-to-jump accumulator ────────────────────────────────────────────
  const handleTypeChar = useCallback((ch: string) => {
    typeBufferRef.current += ch.toLowerCase()
    if (typeBufferTimerRef.current != null) clearTimeout(typeBufferTimerRef.current)
    typeBufferTimerRef.current = setTimeout(() => {
      typeBufferRef.current = ''
      typeBufferTimerRef.current = null
    }, TYPE_BUFFER_RESET_MS)
    const prefix = typeBufferRef.current
    const i = options.findIndex(o => o.label.toLowerCase().startsWith(prefix))
    if (i >= 0) setActiveIndex(i)
  }, [options])

  // ── Keyboard handler ────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (addingOption) return // AddOptionInlineInput owns its own keys
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Wrap so power users can cycle through long option lists.
      // From -1 (no active item, multi mode initial), first ArrowDown → 0.
      setActiveIndex(i => i < 0 ? 0 : (i + 1) % Math.max(1, options.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => i < 0 ? options.length - 1 : (i - 1 + options.length) % Math.max(1, options.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (mode === 'single') {
        handleOptionActivate(activeIndex)
        close()
      } else {
        // Multi: Enter commits the accumulated selection and closes (Space toggles).
        close()
      }
      return
    }
    if (e.key === ' ' && mode === 'multi') {
      e.preventDefault()
      handleOptionActivate(activeIndex)
      return
    }
    if (e.key === 'Tab' && mode === 'single') {
      e.preventDefault()
      const opt = options[activeIndex]
      if (opt && onPickAndAdvance) {
        onPickAndAdvance(opt.value, e.shiftKey ? 'down' : 'right')
        // Mark closed so close() doesn't fire onClose (advance owns lifecycle)
        closedRef.current = true
      } else if (opt) {
        pickSingle(opt.value)
        close()
      }
      return
    }
    // Printable char → type-jump
    if (
      !e.metaKey && !e.ctrlKey && !e.altKey &&
      !e.repeat &&
      e.key.length === 1
    ) {
      e.preventDefault()
      handleTypeChar(e.key)
    }
  }, [
    addingOption, close, options, activeIndex, mode,
    handleOptionActivate, onPickAndAdvance, pickSingle, handleTypeChar,
  ])

  // ── Focus management ────────────────────────────────────────────────────
  useEffect(() => {
    if (!position) return
    // Focus the popover so keyboard events route here.
    if (!addingOption) popoverRef.current?.focus()
  }, [position, addingOption])

  // ── Add-option flow ─────────────────────────────────────────────────────
  const startAddingOption = useCallback(() => {
    onAddOption?.()
    setAddingOption(true)
  }, [onAddOption])

  const handleAddOptionConfirm = useCallback(async (opt: string) => {
    await onAddOptionConfirm?.(opt)
    closedRef.current = true
    onClose()
  }, [onAddOptionConfirm, onClose])

  const handleAddOptionCancel = useCallback(() => {
    setAddingOption(false)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────
  if (!anchorEl || !position) return null

  const body = (
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{ top: position.top, left: position.left }}
      onMouseDown={(e) => { e.stopPropagation() }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="listbox"
      aria-multiselectable={mode === 'multi'}
    >
      {addingOption ? (
        <AddOptionInlineInput
          className={styles.addOptionInput}
          onConfirm={handleAddOptionConfirm}
          onCancel={handleAddOptionCancel}
        />
      ) : options.length === 0 ? (
        <div className={styles.empty}>No options</div>
      ) : (
        <>
          {options.map((opt, i) => {
            const isActive = i === activeIndex
            const isSelected = mode === 'multi'
              ? selectedSet.has(opt.value)
              : (typeof value === 'string' && value === opt.value)
            return (
              <div
                key={opt.value}
                className={`${styles.option} ${isActive ? styles.active : ''}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  handleOptionActivate(i)
                  if (mode === 'single') close()
                }}
              >
                {mode === 'multi' && (
                  <span className={styles.checkbox}>
                    {isSelected ? '☑' : '☐'}
                  </span>
                )}
                {chipStyle ? (
                  <span className={styles.chip} style={chipStyle(opt.value)}>{opt.label}</span>
                ) : (
                  <span className={styles.label}>{opt.label}</span>
                )}
              </div>
            )
          })}
          {onAddOption && (
            <div
              className={styles.addOption}
              role="option"
              onClick={startAddingOption}
            >
              + Add option…
            </div>
          )}
        </>
      )}
    </div>
  )

  return createPortal(body, document.body)
}
