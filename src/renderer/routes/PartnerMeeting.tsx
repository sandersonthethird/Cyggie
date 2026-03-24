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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type {
  PartnerMeetingDigest,
  PartnerMeetingDigestSummary,
  PartnerMeetingItem,
  DigestSuggestion,
  DigestSection,
  ReconcileProposal,
} from '../../shared/types/partner-meeting'
import type { Meeting } from '../../shared/types/meeting'
import { DigestArchiveSidebar } from '../components/partner-meeting/DigestArchiveSidebar'
import { DigestSection as DigestSectionComponent } from '../components/partner-meeting/DigestSection'
import { SuggestionsPanel } from '../components/partner-meeting/SuggestionsPanel'
import { ReconcileModal } from '../components/partner-meeting/ReconcileModal'
import { api } from '../api'
import styles from './PartnerMeeting.module.css'

const ALL_SECTIONS: DigestSection[] = [
  'priorities', 'new_deals', 'existing_deals', 'portfolio_updates', 'passing', 'admin', 'other',
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

  // Meeting picker state
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null)
  const [meetingPickerOpen, setMeetingPickerOpen] = useState(false)
  const [meetingOptions, setMeetingOptions] = useState<Array<{ id: string; title: string; date: string }>>([])
  const [meetingSearch, setMeetingSearch] = useState('')
  const meetingPickerRef = useRef<HTMLDivElement>(null)

  // Reconcile modal state
  const [showReconcileModal, setShowReconcileModal] = useState(false)
  const [reconcileState, setReconcileState] = useState<'generating' | 'ready' | 'error'>('generating')
  const [proposals, setProposals] = useState<ReconcileProposal[]>([])

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
      setMeetingId(digest.meetingId ?? null)
      setMeetingTitle(null)  // will be resolved lazily if meetingId is set

      // Load suggestions only for active digest
      if (digest.status === 'active') {
        api.invoke<DigestSuggestion[]>(IPC_CHANNELS.PARTNER_MEETING_GET_SUGGESTIONS, digest.id)
          .then(s => setSuggestions(s))
          .catch(() => {})
      }
    } catch {
      setState({ status: 'error', message: 'Failed to load digest.' })
    }
  }, [])

  useEffect(() => {
    loadDigest(selectedId)
    loadDigestList()
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve meeting title when meetingId is set on load
  useEffect(() => {
    if (!meetingId) { setMeetingTitle(null); return }
    api.invoke<Meeting>(IPC_CHANNELS.MEETING_GET, meetingId)
      .then(m => { if (m) setMeetingTitle(m.title) })
      .catch(() => {})
  }, [meetingId])

  // Close meeting picker on outside click
  useEffect(() => {
    if (!meetingPickerOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (!meetingPickerRef.current?.contains(e.target as Node)) {
        setMeetingPickerOpen(false)
        setMeetingSearch('')
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [meetingPickerOpen])

  const handleOpenMeetingPicker = useCallback(async () => {
    setMeetingPickerOpen(v => !v)
    if (meetingOptions.length > 0) return  // already loaded
    try {
      const sixtyDaysAgo = new Date()
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
      const list = await api.invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, {
        dateFrom: sixtyDaysAgo.toISOString().slice(0, 10),
        limit: 50,
      })
      setMeetingOptions(
        list.map(m => ({ id: m.id, title: m.title, date: m.date }))
          .sort((a, b) => b.date.localeCompare(a.date))
      )
    } catch {
      // non-critical
    }
  }, [meetingOptions.length])

  const handleSelectMeeting = useCallback(async (id: string, title: string) => {
    if (state.status !== 'loaded') return
    setMeetingPickerOpen(false)
    setMeetingSearch('')
    setMeetingId(id)
    setMeetingTitle(title)
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_SET_MEETING, state.digest.id, id)
    } catch {
      setMeetingId(meetingId)  // revert on error
    }
  }, [state, meetingId])

  const handleClearMeeting = useCallback(async () => {
    if (state.status !== 'loaded') return
    const prev = meetingId
    setMeetingId(null)
    setMeetingTitle(null)
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_SET_MEETING, state.digest.id, null)
    } catch {
      setMeetingId(prev)  // revert on error
    }
  }, [state, meetingId])

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

    const discussed = state.items.filter(
      i => i.isDiscussed && i.companyId && (i.meetingNotes || i.brief || i.statusUpdate),
    )

    if (discussed.length === 0) {
      if (!window.confirm('Conclude this meeting? The digest will be archived and a new one created for next week.')) return
      setConcluding(true)
      try {
        await api.invoke(IPC_CHANNELS.PARTNER_MEETING_CONCLUDE, state.digest.id)
        await loadDigestList()
        setSearchParams({})
        await loadDigest(null)
      } catch {
        alert('Failed to conclude meeting. Please try again.')
      } finally {
        setConcluding(false)
      }
      return
    }

    // Open reconcile modal and start streaming proposals
    setProposals([])
    setReconcileState('generating')
    setShowReconcileModal(true)

    const unsubscribe = api.on(
      IPC_CHANNELS.PARTNER_MEETING_RECONCILE_PROPOSAL,
      (proposal: unknown) => setProposals(prev => [...prev, proposal as ReconcileProposal]),
    )
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_GENERATE_RECONCILIATION, state.digest.id)
      setReconcileState('ready')
    } catch {
      setReconcileState('error')
    } finally {
      unsubscribe()
    }
  }, [state, loadDigestList, loadDigest, setSearchParams])

  const handleReconcileConclude = useCallback(async () => {
    if (state.status !== 'loaded') return
    setShowReconcileModal(false)
    setConcluding(true)
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_CONCLUDE, state.digest.id)
      await loadDigestList()
      setSearchParams({})
      await loadDigest(null)
    } catch {
      alert('Failed to conclude meeting. Please try again.')
    } finally {
      setConcluding(false)
    }
  }, [state, loadDigestList, loadDigest, setSearchParams])

  const handleExportPdf = useCallback(async () => {
    setExporting(true)
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_EXPORT_PDF)
    } catch {
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

  const filteredMeetings = meetingOptions.filter(
    m => !meetingSearch || m.title.toLowerCase().includes(meetingSearch.toLowerCase()),
  )

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
            {/* Meeting picker — active digest only */}
            {isActive && (
              <div ref={meetingPickerRef} className={styles.meetingPickerWrap}>
                {meetingId ? (
                  <span className={styles.meetingChip}>
                    {meetingTitle ?? 'Linked meeting'}
                    <button className={styles.meetingChipClear} onClick={handleClearMeeting} title="Unlink meeting">×</button>
                  </span>
                ) : (
                  <button className={styles.linkMeetingBtn} onClick={handleOpenMeetingPicker}>
                    + Link meeting transcript
                  </button>
                )}
                {meetingPickerOpen && (
                  <div className={styles.meetingDropdown}>
                    <input
                      autoFocus
                      className={styles.meetingSearch}
                      placeholder="Search meetings…"
                      value={meetingSearch}
                      onChange={e => setMeetingSearch(e.target.value)}
                    />
                    <div className={styles.meetingList}>
                      {filteredMeetings.length === 0 && (
                        <div className={styles.meetingEmpty}>No meetings found</div>
                      )}
                      {filteredMeetings.map(m => (
                        <button
                          key={m.id}
                          className={styles.meetingOption}
                          onClick={() => handleSelectMeeting(m.id, m.title)}
                        >
                          <span className={styles.meetingOptionTitle}>{m.title}</span>
                          <span className={styles.meetingOptionDate}>{m.date.slice(0, 10)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
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

      {/* Reconcile modal */}
      {showReconcileModal && (
        <ReconcileModal
          digestId={digest.id}
          meetingId={meetingId}
          weekOf={digest.weekOf}
          proposals={proposals}
          state={reconcileState}
          onConclude={handleReconcileConclude}
          onClose={() => setShowReconcileModal(false)}
        />
      )}
    </div>
  )
}
