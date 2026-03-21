/**
 * PartnerMeeting — Weekly Partner Digest route (/partner-meeting)
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Partner Sync — Mar 18, 2026  [Export PDF]  [Conclude ▸]    │
 *   ├───────────┬──────────────────────────────────────────────────┤
 *   │ DigestArch│  SuggestionsPanel                                 │
 *   │ iveSidebar│  DigestSection × 6 (Priorities, New Deals, etc.) │
 *   └───────────┴──────────────────────────────────────────────────┘
 *
 * Viewing archived digest: all inputs disabled, Conclude button hidden.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type {
  PartnerMeetingDigest,
  PartnerMeetingDigestSummary,
  PartnerMeetingItem,
  DigestSuggestion,
  DigestSection,
} from '../../shared/types/partner-meeting'
import { DigestArchiveSidebar } from '../components/partner-meeting/DigestArchiveSidebar'
import { DigestSection as DigestSectionComponent } from '../components/partner-meeting/DigestSection'
import { SuggestionsPanel } from '../components/partner-meeting/SuggestionsPanel'
import { api } from '../api'
import styles from './PartnerMeeting.module.css'

const ALL_SECTIONS: DigestSection[] = [
  'priorities', 'new_deals', 'existing_deals', 'portfolio_updates', 'passing', 'admin',
]

function formatWeekOf(weekOf: string): string {
  const date = new Date(weekOf + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

type PageState =
  | { status: 'loading' }
  | { status: 'loaded'; digest: PartnerMeetingDigest; items: PartnerMeetingItem[] }
  | { status: 'error'; message: string }

export default function PartnerMeeting() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('id') ?? null

  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [digests, setDigests] = useState<PartnerMeetingDigestSummary[]>([])
  const [suggestions, setSuggestions] = useState<DigestSuggestion[]>([])
  const [concluding, setConcluding] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Load digest list
  const loadDigestList = useCallback(async () => {
    try {
      const list = await api.invoke<PartnerMeetingDigestSummary[]>(IPC_CHANNELS.PARTNER_MEETING_LIST)
      setDigests(list)
    } catch {
      // non-critical
    }
  }, [])

  // Load a specific digest (or active if no id)
  const loadDigest = useCallback(async (id: string | null) => {
    setState({ status: 'loading' })
    setSuggestions([])
    try {
      const digest = id
        ? await api.invoke<PartnerMeetingDigest>(IPC_CHANNELS.PARTNER_MEETING_GET, id)
        : await api.invoke<PartnerMeetingDigest>(IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE)

      if (!digest) {
        setState({ status: 'error', message: 'Digest not found.' })
        return
      }

      setState({ status: 'loaded', digest, items: digest.items ?? [] })

      // Load suggestions only for active digest
      if (digest.status === 'active') {
        api.invoke<DigestSuggestion[]>(IPC_CHANNELS.PARTNER_MEETING_GET_SUGGESTIONS, digest.id)
          .then(s => setSuggestions(s))
          .catch(() => {})
      }
    } catch (err) {
      setState({ status: 'error', message: 'Failed to load digest.' })
    }
  }, [])

  useEffect(() => {
    loadDigest(selectedId)
    loadDigestList()
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDigest = useCallback((id: string) => {
    const digest = digests.find(d => d.id === id)
    if (digest?.status === 'active') {
      setSearchParams({})
    } else {
      setSearchParams({ id })
    }
  }, [digests, setSearchParams])

  const handleItemsChange = useCallback((updater: (items: PartnerMeetingItem[]) => PartnerMeetingItem[]) => {
    setState(s => s.status === 'loaded' ? { ...s, items: updater(s.items) } : s)
  }, [])

  const handleSuggestionDismiss = useCallback((companyId: string) => {
    setSuggestions(s => s.filter(x => x.companyId !== companyId))
  }, [])

  const handleSuggestionAdded = useCallback((item: PartnerMeetingItem) => {
    setState(s => {
      if (s.status !== 'loaded') return s
      const exists = s.items.find(i => i.id === item.id)
      return {
        ...s,
        items: exists ? s.items.map(i => i.id === item.id ? item : i) : [...s.items, item],
      }
    })
    setSuggestions(s => s.filter(x => x.companyId !== item.companyId))
  }, [])

  const handleConclude = useCallback(async () => {
    if (state.status !== 'loaded') return
    if (!window.confirm('Conclude this meeting? The digest will be archived and a new one created for next week.')) return

    setConcluding(true)
    try {
      const newDigest = await api.invoke<PartnerMeetingDigest>(
        IPC_CHANNELS.PARTNER_MEETING_CONCLUDE,
        state.digest.id
      )
      await loadDigestList()
      // Navigate to the new active digest
      setSearchParams({})
      await loadDigest(null)
    } catch (err) {
      alert('Failed to conclude meeting. Please try again.')
    } finally {
      setConcluding(false)
    }
  }, [state, loadDigestList, loadDigest, setSearchParams])

  const handleExportPdf = useCallback(async () => {
    setExporting(true)
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_EXPORT_PDF)
    } catch (err) {
      alert('Failed to export PDF.')
    } finally {
      setExporting(false)
    }
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (state.status === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading…</div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={styles.page}>
        <div className={styles.errorState}>{state.message}</div>
      </div>
    )
  }

  const { digest, items } = state
  const isActive = digest.status === 'active'
  const currentDigestId = digests.find(d => d.status === 'active')?.id

  return (
    <div className={styles.page}>
      <DigestArchiveSidebar
        digests={digests}
        selectedId={digest.id}
        onSelect={handleSelectDigest}
      />

      <div className={styles.content}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>Partner Sync</h1>
            <div className={styles.weekOf}>
              {formatWeekOf(digest.weekOf)}
              {!isActive && <span className={styles.archivedBadge}>Archived</span>}
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.exportBtn}
              onClick={handleExportPdf}
              disabled={exporting}
            >
              {exporting ? 'Exporting…' : 'Export PDF'}
            </button>
            {isActive && (
              <button
                className={styles.concludeBtn}
                onClick={handleConclude}
                disabled={concluding}
              >
                {concluding ? 'Concluding…' : 'Conclude Meeting ▸'}
              </button>
            )}
          </div>
        </div>

        {/* Suggestions banner (active only) */}
        {isActive && suggestions.length > 0 && (
          <SuggestionsPanel
            digestId={digest.id}
            suggestions={suggestions}
            onDismiss={handleSuggestionDismiss}
            onAdded={handleSuggestionAdded}
          />
        )}

        {/* Sections */}
        <div className={styles.sections}>
          {ALL_SECTIONS.map(sectionId => (
            <DigestSectionComponent
              key={sectionId}
              sectionId={sectionId}
              items={items}
              digestId={digest.id}
              disabled={!isActive}
              onItemsChange={handleItemsChange}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
