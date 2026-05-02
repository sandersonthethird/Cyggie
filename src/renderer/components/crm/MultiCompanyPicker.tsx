/**
 * MultiCompanyPicker — detail-panel investor list editor.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ State machine                                        │
 *   │   idle ─click "+ Add"─▶ adding                        │
 *   │     │                    │                            │
 *   │     │                    ├─Enter on typed name───▶ findOrCreate │
 *   │     │                    ├─pick suggestion──────▶ add      │
 *   │     │                    └─Esc/outside click────▶ idle     │
 *   │   idle ─click chip name─▶ navigate to /company/:id          │
 *   │   idle ─click X──────────▶ remove from value                │
 *   └──────────────────────────────────────────────────────┘
 *
 * Refactored in Phase 1 to:
 *   - Use the shared CompanyChip component (DRY with InvestorChipsCell)
 *   - Use useInvestorChips hook for find-or-create + fuzzy match
 *   - Accept entries WITH optional domain (for favicon support)
 *
 * Backward-compatible API: { value, onChange, readOnly } unchanged.
 * The 3 detail-panel call sites (CompanyFieldSections.tsx) work without modification.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInvestorChips, type InvestorEntry } from '../../hooks/useInvestorChips'
import { CompanyChip } from '../common/CompanyChip'
import styles from './MultiCompanyPicker.module.css'

type ValueEntry = { id: string; name: string; domain?: string | null }

interface MultiCompanyPickerProps {
  value: ValueEntry[]
  onChange: (value: InvestorEntry[]) => void
  readOnly?: boolean
  /** Limit number of chips. When set to 1, adding evicts the existing chip (auto-replace). */
  maxChips?: number
  /** Optional per-chip badge factory (e.g. for overlap counts). */
  badgeFor?: (id: string) => { content: React.ReactNode; title?: string } | null
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function MultiCompanyPicker({ value, onChange, readOnly = false, maxChips, badgeFor }: MultiCompanyPickerProps) {
  const navigate = useNavigate()
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const { suggestions, search, findOrCreate, fuzzyMatch } = useInvestorChips()

  // Normalize value entries to InvestorEntry shape (fill missing domain).
  const entries = useMemo<InvestorEntry[]>(
    () => value.map((v) => ({ id: v.id, name: v.name, domain: v.domain ?? null })),
    [value]
  )

  // Filter suggestions: drop already-added.
  const filtered = useMemo(
    () => suggestions.filter((s) => !entries.some((e) => e.id === s.id)),
    [suggestions, entries]
  )

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  useEffect(() => {
    if (!adding) return
    search(input)
    setActiveIdx(0)
  }, [input, adding, search])

  // Click outside closes adding mode
  useEffect(() => {
    if (!adding) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return
      setAdding(false)
      setInput('')
      setError(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [adding])

  const handleNavigate = useCallback((id: string) => {
    navigate(`/company/${id}`)
  }, [navigate])

  const handleRemove = useCallback((id: string) => {
    onChange(entries.filter((e) => e.id !== id))
  }, [entries, onChange])

  const addEntry = useCallback((entry: InvestorEntry) => {
    if (entries.some((e) => e.id === entry.id)) return
    if (maxChips && entries.length >= maxChips) {
      // Auto-replace: drop the oldest chip(s), append the new one.
      const replaced = entries[entries.length - 1]
      setError(`Replaced ${replaced.name} with ${entry.name}`)
      window.setTimeout(() => setError((e) => (e === `Replaced ${replaced.name} with ${entry.name}` ? null : e)), 2000)
      onChange([...entries.slice(0, maxChips - 1), entry])
      return
    }
    onChange([...entries, entry])
  }, [entries, onChange, maxChips])

  const commitInput = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    // Exact match? Use existing.
    const exact = filtered.find((s) => normalizeName(s.canonicalName) === normalizeName(trimmed))
    if (exact) {
      addEntry({ id: exact.id, name: exact.canonicalName, domain: exact.primaryDomain ?? null })
      setInput('')
      return
    }

    // Fuzzy match? Auto-link if ≥3 chars and prefix-like; otherwise create.
    const fuzzy = fuzzyMatch(trimmed, filtered)
    if (fuzzy && trimmed.length >= 3 && normalizeName(fuzzy.canonicalName).startsWith(normalizeName(trimmed))) {
      addEntry({ id: fuzzy.id, name: fuzzy.canonicalName, domain: fuzzy.primaryDomain ?? null })
      setInput('')
      return
    }

    // Find-or-create
    try {
      const entry = await findOrCreate(trimmed)
      addEntry(entry)
      setInput('')
    } catch (err) {
      console.error('[MultiCompanyPicker] findOrCreate failed:', err)
      setError(`Couldn't add: ${trimmed}`)
    }
  }, [input, filtered, addEntry, fuzzyMatch, findOrCreate])

  const handleKeyDown = useCallback(async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[activeIdx] && activeIdx < filtered.length && input.trim()) {
        const sel = filtered[activeIdx]
        const isTopHit = activeIdx === 0
        if (isTopHit && input.trim().length >= 3 && normalizeName(sel.canonicalName).startsWith(normalizeName(input.trim()))) {
          addEntry({ id: sel.id, name: sel.canonicalName, domain: sel.primaryDomain ?? null })
          setInput('')
          return
        }
      }
      await commitInput()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setAdding(false)
      setInput('')
      setError(null)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
      return
    }
  }, [activeIdx, filtered, input, addEntry, commitInput])

  return (
    <div ref={wrapRef} className={styles.container}>
      {entries.map((entry) => {
        const badge = badgeFor?.(entry.id) ?? null
        return (
          <CompanyChip
            key={entry.id}
            id={entry.id}
            name={entry.name}
            domain={entry.domain}
            readOnly={readOnly}
            onClickName={handleNavigate}
            onRemove={readOnly ? undefined : handleRemove}
            badge={badge?.content}
            badgeTitle={badge?.title}
          />
        )
      })}

      {!readOnly && (
        adding ? (
          <div style={{ position: 'relative' }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search or type a name…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
                width: 200,
              }}
            />
            {filtered.length > 0 && (
              <ul
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 10,
                  background: 'var(--color-card-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  marginTop: 2,
                  padding: 0,
                  listStyle: 'none',
                  width: 240,
                  maxHeight: 200,
                  overflowY: 'auto',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                }}
              >
                {filtered.slice(0, 8).map((s, idx) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        addEntry({ id: s.id, name: s.canonicalName, domain: s.primaryDomain ?? null })
                        setInput('')
                        inputRef.current?.focus()
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        background: idx === activeIdx ? 'var(--color-bg-secondary)' : 'transparent',
                        border: 'none',
                        padding: '5px 8px',
                        fontSize: 12,
                        fontFamily: 'inherit',
                        color: 'var(--color-text)',
                        cursor: 'pointer',
                      }}
                    >
                      {s.canonicalName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 2 }}>{error}</div>
            )}
          </div>
        ) : (
          <button
            className={styles.addBtn}
            onClick={() => { setAdding(true); setError(null) }}
            type="button"
          >
            + Add company
          </button>
        )
      )}
    </div>
  )
}
