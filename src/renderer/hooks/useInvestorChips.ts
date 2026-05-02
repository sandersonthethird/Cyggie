/**
 * useInvestorChips — data-only hook for investor chip editing.
 *
 * Owns:    company search (debounced), find-or-create, paste-list parsing, fuzzy-match dedup.
 * Does NOT own: chip list state, popover lifecycle, pending state, drag-reorder.
 *               (UIs manage those — the hook is shared between InvestorChipsCell and
 *                the refactored MultiCompanyPicker, each with different UX.)
 *
 *   ┌────────────────────────────────────────────┐
 *   │ INPUTS:  none (stateless hook)             │
 *   │ OUTPUTS: { search, findOrCreate, parseList,│
 *   │            fuzzyMatch, suggestions,        │
 *   │            searching }                     │
 *   └────────────────────────────────────────────┘
 */
import { useCallback } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { usePicker } from './usePicker'
import { fuzzyMatchExisting } from '../../shared/utils/fuzzy-match'
import type { CompanySummary } from '../../shared/types/company'

export interface InvestorEntry {
  id: string
  name: string
  domain: string | null
}

export interface UseInvestorChipsResult {
  /** Current debounced search results (for autocomplete dropdown). */
  suggestions: CompanySummary[]
  /** Whether a search is in flight. */
  searching: boolean
  /** Trigger a new search (debounced via usePicker). */
  search: (query: string) => void
  /** Resolve a free-text name to a company, creating a stub if no exact match exists. */
  findOrCreate: (name: string) => Promise<InvestorEntry>
  /** Parse a pasted multi-name string ("A, B; C\nD") → deduped, trimmed names (max 25). */
  parseList: (raw: string, existing: InvestorEntry[]) => { names: string[]; clamped: boolean }
  /** Find a close-enough fuzzy match (Levenshtein ≤ 2, similar length); null if no near miss. */
  fuzzyMatch: (typed: string, candidates: CompanySummary[]) => CompanySummary | null
}

const MAX_PASTE_NAMES = 25
const MAX_NAME_LENGTH = 100

/** Split on comma / semicolon / newline / tab. Keeps names with internal spaces intact. */
function splitMultiDelim(raw: string): string[] {
  return raw
    .split(/[,;\n\t]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_NAME_LENGTH)
}

export function useInvestorChips(): UseInvestorChipsResult {
  const picker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })

  const search = useCallback(
    (query: string) => {
      picker.search(query)
    },
    [picker]
  )

  const findOrCreate = useCallback(async (name: string): Promise<InvestorEntry> => {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
    if (!trimmed) throw new Error('Investor name cannot be empty')
    const company = await api.invoke<CompanySummary>(
      IPC_CHANNELS.COMPANY_FIND_OR_CREATE,
      trimmed
    )
    if (!company || !company.id) {
      throw new Error(`Failed to resolve investor: ${trimmed}`)
    }
    return {
      id: company.id,
      name: company.canonicalName,
      domain: company.primaryDomain ?? null,
    }
  }, [])

  const parseList = useCallback(
    (raw: string, existing: InvestorEntry[]): { names: string[]; clamped: boolean } => {
      const tokens = splitMultiDelim(raw)
      const seenLower = new Set(existing.map((e) => e.name.trim().toLowerCase()))
      const out: string[] = []
      for (const token of tokens) {
        const lower = token.toLowerCase()
        if (seenLower.has(lower)) continue
        seenLower.add(lower)
        out.push(token)
        if (out.length >= MAX_PASTE_NAMES) break
      }
      return {
        names: out,
        clamped: tokens.length > MAX_PASTE_NAMES,
      }
    },
    []
  )

  const fuzzyMatch = useCallback(
    (typed: string, candidates: CompanySummary[]): CompanySummary | null => {
      const named = candidates.map((c) => ({ ...c, name: c.canonicalName }))
      const match = fuzzyMatchExisting(typed, named, 2)
      if (!match) return null
      return candidates.find((c) => c.id === match.id) ?? null
    },
    []
  )

  return {
    suggestions: picker.results,
    searching: picker.searching,
    search,
    findOrCreate,
    parseList,
    fuzzyMatch,
  }
}
