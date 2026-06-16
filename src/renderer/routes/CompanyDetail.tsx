import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useRemoteApply } from '../api/useRemoteApply'
import type { BackNavState } from '../utils/backNavState'
import { Share2 } from 'lucide-react'
import { AddToSyncModal } from '../components/partner-meeting/AddToSyncModal'
import { IPC_CHANNELS, type IpcChannel } from '../../shared/constants/channels'
import type { CompanyDetail as CompanyDetailType, CompanyMeetingRef } from '../../shared/types/company'
import { ENTITY_TYPE_OPTIONS } from '../../shared/types/company'
import type { CompanySummaryUpdateProposal, CompanySummaryUpdateChange, CompanySummaryUpdatePayload, EnrichmentResult, EnrichmentFailureReason } from '../../shared/types/summary'
import { companyEnrichedAtKey } from '../../shared/utils/enrichment-keys'
import type { SetCustomFieldValueInput } from '../../shared/types/custom-fields'
import { serializeCustomFieldValue } from '../../shared/custom-field-values'
import { CompanyPropertiesPanel } from '../components/company/CompanyPropertiesPanel'
import { CompanyEnrichModal } from '../components/company/CompanyEnrichModal'
import type { PitchDeckExtractionResult } from '../../shared/types/pitch-deck'
import { CompanyTimeline } from '../components/company/CompanyTimeline'
import { CompanyContacts } from '../components/company/CompanyContacts'
import { CompanyNotes } from '../components/company/CompanyNotes'
import { CompanyMemo } from '../components/company/CompanyMemo'
import { CompanyFiles } from '../components/company/CompanyFiles'
import { CompanyDecisions } from '../components/company/CompanyDecisions'
import { EnrichmentProposalDialog } from '../components/enrichment/EnrichmentProposalDialog'
import type { EnrichmentEntityProposal } from '../components/enrichment/EnrichmentProposalDialog'
import { RecordTopBar } from '../components/common/RecordTopBar'
import { useChatStore } from '../stores/chat.store'
import { usePanelResize } from '../hooks/usePanelResize'
import layoutStyles from './TwoColumnLayout.module.css'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'timeline' | 'contacts' | 'notes' | 'thesis' | 'memo' | 'files' | 'decisions'

function enrichmentErrorMessage(
  reason: EnrichmentFailureReason,
  source: 'meetings' | 'notes' | 'emails',
): string {
  switch (reason) {
    case 'no_content':
      return source === 'meetings'
        ? 'No meeting content available to enrich from'
        : `No ${source} content available to enrich from`
    case 'llm_failed':
      return 'AI service failed — please try again'
    case 'parse_failed':
      return 'Could not parse AI response — please try again'
    case 'company_not_found':
      return 'Company not found'
  }
}

export default function CompanyDetail() {
  const { companyId: id } = useParams<{ companyId: string }>()
  const location = useLocation()
  const stateFrom = (location.state as BackNavState | null)?.from
  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<CompanyTab>('timeline')
  const [timelineKey, setTimelineKey] = useState(0)
  const { leftWidth, dividerProps } = usePanelResize({ defaultWidth: 360 })
  const [addToSyncOpen, setAddToSyncOpen] = useState(false)

  // Meetings (for enrichment banner)
  const [companyMeetings, setCompanyMeetings] = useState<CompanyMeetingRef[]>([])

  // ── Meetings-based enrichment (CRM fields only) ──────────────────────────
  const [enrichProposal, setEnrichProposal] = useState<CompanySummaryUpdateProposal | null>(null)
  const [enrichDialogOpen, setEnrichDialogOpen] = useState(false)
  const [fieldSelections, setFieldSelections] = useState<Record<string, boolean>>({})
  const [isLoadingEnrich, setIsLoadingEnrich] = useState(false)
  const [isApplyingEnrich, setIsApplyingEnrich] = useState(false)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [enrichSuccessMsg, setEnrichSuccessMsg] = useState<string | null>(null)
  const [lastEnrichedAt, setLastEnrichedAt] = useState<string | null>(() =>
    id ? localStorage.getItem(companyEnrichedAtKey(id)) : null
  )

  // ── File enrichment modal ────────────────────────────────────────────────
  const [enrichModalOpen, setEnrichModalOpen] = useState(false)
  const [enrichSource, setEnrichSource] = useState<'pdf' | 'url' | null>(null)
  const [enrichJustCompleted, setEnrichJustCompleted] = useState(false)
  const [highlightNoteId, setHighlightNoteId] = useState<string | null>(null)
  const [notesVersion, setNotesVersion] = useState(0)
  // Bumped whenever a note is created/edited/deleted from any tab, so the
  // sibling tabs (which are always mounted) silently re-pull fresh note data.
  const [noteSyncKey, setNoteSyncKey] = useState(0)
  const bumpNoteSync = useCallback(() => setNoteSyncKey((k) => k + 1), [])
  const enrichCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setPageContext = useChatStore((s) => s.setPageContext)

  const reloadCompany = useCallback(() => {
    if (!id) return
    window.api
      .invoke<CompanyDetailType>(IPC_CHANNELS.COMPANY_GET, id)
      .then((data) => setCompany(data ?? null))
      .catch(console.error)
  }, [id])

  useEffect(() => {
    if (!id) return
    setLastEnrichedAt(localStorage.getItem(companyEnrichedAtKey(id)))
    setLoading(true)
    window.api
      .invoke<CompanyDetailType>(IPC_CHANNELS.COMPANY_GET, id)
      .then((data) => setCompany(data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id])

  // 2026-05-24 — refresh on remote-apply broadcasts. Three subscriptions:
  //   • ORG_COMPANIES: this row may have been edited on mobile
  //   • CONTACTS: a person on the People sidebar got renamed/created
  //   • MEETINGS: a meeting was linked to this company from mobile (the
  //     reloadMeetings effect below picks it up via the meeting fetch)
  useRemoteApply(IPC_CHANNELS.ORG_COMPANIES_REMOTE_APPLIED, (ids) => {
    if (id && ids.includes(id)) reloadCompany()
  })
  useRemoteApply(IPC_CHANNELS.CONTACTS_REMOTE_APPLIED, () => reloadCompany())

  // Register this company as the chat page context so the global floating chat
  // shows entity-scoped options while on this page.
  useEffect(() => {
    if (!company) return
    setPageContext({ contextOptions: [{ type: 'company', id: company.id, name: company.canonicalName }] })
    return () => setPageContext(null)
  }, [company?.id, company?.canonicalName, setPageContext])

  const reloadCompanyMeetings = useCallback(() => {
    if (!id) return
    window.api
      .invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, id)
      .then((data) => setCompanyMeetings(Array.isArray(data) ? data : []))
      .catch(() => setCompanyMeetings([]))
  }, [id])

  // Fetch meetings when id or company loads
  useEffect(() => {
    reloadCompanyMeetings()
  }, [reloadCompanyMeetings])

  useRemoteApply(IPC_CHANNELS.MEETINGS_REMOTE_APPLIED, () => reloadCompanyMeetings())

  // Clear highlight after 3s
  useEffect(() => {
    if (!highlightNoteId) return
    const t = setTimeout(() => setHighlightNoteId(null), 3000)
    return () => clearTimeout(t)
  }, [highlightNoteId])

  // A meeting is "enrichable" only if we can actually pull content from it: a
  // readable on-disk summary, a Drive backup ID, or non-empty user-typed notes.
  // Without this filter the badge counts meetings whose summary_path points to
  // a missing file and clicking the banner just shows a misleading error toast.
  const enrichableMeetings = useMemo(
    () => companyMeetings.filter((m) =>
      m.status === 'summarized'
      && (m.hasReadableSummary || m.hasSummaryDriveId || m.hasNonEmptyNotes)),
    [companyMeetings]
  )

  const showEnrichBanner = useMemo(() => {
    if (enrichableMeetings.length === 0) return false
    if (!lastEnrichedAt) return true
    return enrichableMeetings.some((m) => m.date > lastEnrichedAt)
  }, [enrichableMeetings, lastEnrichedAt])

  // Parse fieldSources for hover tooltips
  const parsedFieldSources = useMemo((): Record<string, { meetingId: string; meetingTitle: string }> => {
    if (!company?.fieldSources) return {}
    try {
      const raw = JSON.parse(company.fieldSources) as Record<string, string>
      const result: Record<string, { meetingId: string; meetingTitle: string }> = {}
      for (const [field, meetingId] of Object.entries(raw)) {
        const m = companyMeetings.find((mt) => mt.id === meetingId)
        result[field] = { meetingId, meetingTitle: m?.title ?? 'a meeting' }
      }
      return result
    } catch {
      return {}
    }
  }, [company, companyMeetings])

  function handleUpdate(updates: Record<string, unknown>) {
    setCompany((prev) => prev ? { ...prev, ...updates } : prev)
    if ('pipelineStage' in updates) {
      setTimelineKey((k) => k + 1)
    }
  }

  const handleEnrichFromMeetings = useCallback(async () => {
    if (!id || enrichableMeetings.length === 0) return
    setIsLoadingEnrich(true)
    setEnrichError(null)
    try {
      const result = await window.api.invoke<EnrichmentResult>(
        IPC_CHANNELS.COMPANY_ENRICH_FROM_MEETINGS,
        enrichableMeetings.map((m) => m.id),
        id
      )
      if (!result.ok) {
        setEnrichError(enrichmentErrorMessage(result.reason, 'meetings'))
        setTimeout(() => setEnrichError(null), 4000)
      } else if (result.proposal.changes.length > 0 || (result.proposal.customFieldUpdates?.length ?? 0) > 0) {
        const selections: Record<string, boolean> = {}
        for (const change of result.proposal.changes) {
          selections[`${id}:${change.field}`] = true
        }
        for (const cfu of result.proposal.customFieldUpdates ?? []) {
          selections[`${id}:${cfu.label}`] = true
        }
        setFieldSelections(selections)
        setEnrichProposal(result.proposal)
        setEnrichDialogOpen(true)
      } else {
        const enrichedAt = new Date().toISOString()
        localStorage.setItem(companyEnrichedAtKey(id), enrichedAt)
        setLastEnrichedAt(enrichedAt)
        setEnrichSuccessMsg('Profile is already up to date')
        setTimeout(() => setEnrichSuccessMsg(null), 3000)
      }
    } catch (err) {
      console.error('[CompanyDetail] Failed to load enrichment proposals:', err)
      setEnrichError('Could not load enrichment — please try again')
      setTimeout(() => setEnrichError(null), 4000)
    } finally {
      setIsLoadingEnrich(false)
    }
  }, [enrichableMeetings, id])

  const handleApplyEnrich = useCallback(async () => {
    if (!enrichProposal || !id) return
    setEnrichDialogOpen(false)

    const selectedFields = new Set(
      Object.entries(fieldSelections)
        .filter(([, v]) => v !== false)
        .map(([k]) => k.replace(`${id}:`, ''))
    )

    setIsApplyingEnrich(true)
    try {
      const builtinFields = ['description', 'round', 'raiseSize', 'postMoneyValuation', 'city', 'state', 'pipelineStage'] as const
      const filteredUpdates: Record<string, unknown> = {}
      for (const field of builtinFields) {
        if (selectedFields.has(field) && enrichProposal.updates[field] !== undefined) {
          filteredUpdates[field] = enrichProposal.updates[field]
        }
      }

      if (enrichProposal.updates.fieldSources) {
        try {
          const allSources = JSON.parse(enrichProposal.updates.fieldSources) as Record<string, string>
          const filteredSources: Record<string, string> = {}
          for (const [field, meetingId] of Object.entries(allSources)) {
            if (selectedFields.has(field)) filteredSources[field] = meetingId
          }
          const existingSources: Record<string, string> = {}
          if (company?.fieldSources) {
            try {
              const prev = JSON.parse(company.fieldSources) as Record<string, string>
              Object.assign(existingSources, prev)
            } catch { /* ignore */ }
          }
          const merged = { ...existingSources, ...filteredSources }
          if (Object.keys(merged).length > 0) {
            filteredUpdates.fieldSources = JSON.stringify(merged)
          }
        } catch { /* ignore fieldSources parse error */ }
      }

      if (Object.keys(filteredUpdates).length > 0) {
        await window.api.invoke(IPC_CHANNELS.COMPANY_UPDATE, id, filteredUpdates)
      }

      for (const cfu of enrichProposal.customFieldUpdates ?? []) {
        if (!selectedFields.has(cfu.label)) continue
        const input: SetCustomFieldValueInput = {
          fieldDefinitionId: cfu.fieldDefinitionId,
          entityId: id,
          entityType: 'company',
          ...serializeCustomFieldValue(cfu.fieldType, cfu.newValue),
        }
        await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
      }

      const updated = await window.api.invoke<CompanyDetailType>(IPC_CHANNELS.COMPANY_GET, id)
      if (updated) setCompany(updated)

      const enrichedAt = new Date().toISOString()
      localStorage.setItem(companyEnrichedAtKey(id), enrichedAt)
      setLastEnrichedAt(enrichedAt)
      setEnrichSuccessMsg(`${enrichProposal.companyName} updated`)
      setTimeout(() => setEnrichSuccessMsg(null), 3000)
    } catch (err) {
      console.error('[CompanyDetail] Failed to apply enrichment:', err)
    } finally {
      setEnrichProposal(null)
      setIsApplyingEnrich(false)
    }
  }, [enrichProposal, fieldSelections, id, company])

  const handleEnrichFromSource = useCallback(async (channel: IpcChannel, errorContext: 'notes' | 'emails') => {
    if (!id) return
    setIsLoadingEnrich(true)
    setEnrichError(null)
    try {
      const result = await window.api.invoke<EnrichmentResult>(channel, id)
      if (!result.ok) {
        setEnrichError(enrichmentErrorMessage(result.reason, errorContext))
        setTimeout(() => setEnrichError(null), 4000)
      } else if (result.proposal.changes.length > 0 || (result.proposal.customFieldUpdates?.length ?? 0) > 0) {
        const selections: Record<string, boolean> = {}
        for (const change of result.proposal.changes) selections[`${id}:${change.field}`] = true
        for (const cfu of result.proposal.customFieldUpdates ?? []) selections[`${id}:${cfu.label}`] = true
        setFieldSelections(selections)
        setEnrichProposal(result.proposal)
        setEnrichDialogOpen(true)
      } else {
        // do NOT update lastEnrichedAt — that gates the meetings banner only
        setEnrichSuccessMsg('Profile is already up to date')
        setTimeout(() => setEnrichSuccessMsg(null), 3000)
      }
    } catch (err) {
      console.error(`[CompanyDetail] Failed to load enrichment from ${errorContext}:`, err)
      setEnrichError(`Could not analyze ${errorContext} — please try again`)
      setTimeout(() => setEnrichError(null), 4000)
    } finally {
      setIsLoadingEnrich(false)
    }
  }, [id])

  const handleEnrich = useCallback((source: 'pdf' | 'url' | 'meetings' | 'notes' | 'emails') => {
    if (source === 'meetings') {
      void handleEnrichFromMeetings()
      return
    }
    if (source === 'notes') {
      void handleEnrichFromSource(IPC_CHANNELS.COMPANY_ENRICH_FROM_NOTES, 'notes')
      return
    }
    if (source === 'emails') {
      void handleEnrichFromSource(IPC_CHANNELS.COMPANY_ENRICH_FROM_EMAILS, 'emails')
      return
    }
    setEnrichSource(source)
    setEnrichModalOpen(true)
  }, [handleEnrichFromMeetings, handleEnrichFromSource])

  const handleEnrichComplete = useCallback((noteId: string | null) => {
    setEnrichModalOpen(false)
    setEnrichSource(null)

    // Flash the Enrich button and update last-enhanced timestamp
    setEnrichJustCompleted(true)
    if (enrichCompleteTimerRef.current) clearTimeout(enrichCompleteTimerRef.current)
    enrichCompleteTimerRef.current = setTimeout(() => setEnrichJustCompleted(false), 3500)

    if (noteId) {
      setHighlightNoteId(noteId)
      setNotesVersion(v => v + 1)
      setActiveTab('notes')
      // Refetch company to update note count badge
      if (id) {
        window.api.invoke<CompanyDetailType>(IPC_CHANNELS.COMPANY_GET, id)
          .then((data) => { if (data) setCompany(data) })
          .catch(console.error)
      }
    }
  }, [id])

  // Build proposals for the shared dialog (meetings enrichment)
  const dialogProposals = useMemo((): EnrichmentEntityProposal[] => {
    if (!enrichProposal || !id) return []
    const changes = [
      ...enrichProposal.changes.map((c) => ({
        key: `${id}:${c.field}`,
        label: c.field,
        from: c.from != null ? String(c.from) : null,
        to: String(c.to),
      })),
      ...(enrichProposal.customFieldUpdates ?? []).map((cfu) => ({
        key: `${id}:${cfu.label}`,
        label: cfu.label,
        from: cfu.fromDisplay,
        to: cfu.toDisplay,
      })),
    ]
    return [{ entityId: id, entityName: enrichProposal.companyName, changes }]
  }, [enrichProposal, id])

  if (loading) {
    return <div className={layoutStyles.loading}>Loading…</div>
  }
  if (!company) {
    return <div className={layoutStyles.notFound}>Company not found.</div>
  }

  const tabs: Array<{ key: CompanyTab; label: string; badge?: number }> = [
    {
      key: 'timeline',
      label: 'Timeline',
      badge: (company.meetingCount || 0) + (company.emailCount || 0) + (company.noteCount || 0) || undefined
    },
    { key: 'contacts', label: 'Contacts', badge: company.contactCount || undefined },
    { key: 'notes', label: 'Notes', badge: company.noteCount || undefined },
    { key: 'thesis', label: 'Thesis' },
    { key: 'decisions', label: 'Decisions' },
    { key: 'memo', label: 'Memo' },
    { key: 'files', label: 'Files' }
  ]

  const entityLabel = ENTITY_TYPE_OPTIONS.find(o => o.value === company.entityType)?.label ?? 'Companies'
  const entityLabelPlural = entityLabel === 'Prospect' ? 'Prospects'
    : entityLabel === 'Portfolio' ? 'Portfolio'
    : entityLabel + 's'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <RecordTopBar
        backLabel="Back"
        backFallback="/companies"
        breadcrumbs={[
          { label: 'Companies', href: stateFrom ?? '/companies' },
          { label: entityLabelPlural, href: `/companies?entityType=${company.entityType}` },
          { label: company.canonicalName },
        ]}
        actions={
          <>
            <button className={layoutStyles.tabBtn} style={{ border: '1px solid var(--cy-border, var(--color-border))', borderRadius: 6, padding: '0 12px', height: 30 }}>
              <Share2 size={13} strokeWidth={1.6} /> Share
            </button>
          </>
        }
      />
    <div className={layoutStyles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr`, flex: 1 }}>
      {/* Left panel — properties */}
      <div className={layoutStyles.leftPanel}>
        <CompanyPropertiesPanel
          company={company}
          onUpdate={handleUpdate}
          showEnrichBanner={showEnrichBanner}
          enrichMeetingCount={enrichableMeetings.length}
          fieldSources={parsedFieldSources}
          onEnrich={handleEnrich}
          isLoadingEnrich={isLoadingEnrich}
          onOpenSync={() => setAddToSyncOpen(true)}
        />
        {enrichSuccessMsg && (
          <div className={styles.enrichSuccess}>
            ✓ {enrichSuccessMsg}
          </div>
        )}
        {enrichError && (
          <div className={styles.enrichError}>
            {enrichError}
          </div>
        )}
      </div>

      {/* Resizable divider */}
      <div className={layoutStyles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={layoutStyles.rightPanel}>
        <div className={layoutStyles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${layoutStyles.tabBtn} ${activeTab === tab.key ? layoutStyles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={layoutStyles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* All tabs always mounted (CSS hide/show) to preserve CompanyMemo draft state */}
        <div className={layoutStyles.tabContent}>
          <div className={activeTab !== 'timeline' ? layoutStyles.hidden : ''}>
            <CompanyTimeline companyId={company.id} refreshKey={timelineKey} noteSyncKey={noteSyncKey} onNoteChange={bumpNoteSync} />
          </div>
          <div className={activeTab !== 'contacts' ? layoutStyles.hidden : ''}>
            <CompanyContacts companyId={company.id} />
          </div>
          <div className={activeTab !== 'notes' ? layoutStyles.hidden : ''}>
            <CompanyNotes companyId={company.id} highlightNoteId={highlightNoteId ?? undefined} refreshKey={notesVersion} noteSyncKey={noteSyncKey} onNoteChange={bumpNoteSync} />
          </div>
          <div className={activeTab !== 'thesis' ? layoutStyles.hidden : ''}>
            <div style={{ padding: 32, color: 'var(--color-text-tertiary)', fontSize: 14 }}>
              Thesis — coming soon. Track your investment thesis, claims, and supporting evidence.
            </div>
          </div>
          <div className={activeTab !== 'decisions' ? layoutStyles.hidden : ''}>
            <CompanyDecisions companyId={company.id} />
          </div>
          <div className={activeTab !== 'memo' ? layoutStyles.hidden : ''}>
            <CompanyMemo companyId={company.id} />
          </div>
          <div className={activeTab !== 'files' ? layoutStyles.hidden : ''}>
            <CompanyFiles companyId={company.id} />
          </div>
        </div>
      </div>

      {addToSyncOpen && (
        <AddToSyncModal
          company={company}
          onClose={() => setAddToSyncOpen(false)}
        />
      )}

      {company && (
        <CompanyEnrichModal
          open={enrichModalOpen}
          company={company}
          onClose={() => { setEnrichModalOpen(false); setEnrichSource(null) }}
          onComplete={handleEnrichComplete}
        />
      )}

      {enrichDialogOpen && enrichProposal && (
        <EnrichmentProposalDialog
          open={true}
          title="Enrich company profile"
          subtitle="New information was found in meeting summaries. Select which updates to apply."
          proposals={dialogProposals}
          fieldSelections={fieldSelections}
          onFieldToggle={(key, value) => setFieldSelections((prev) => ({ ...prev, [key]: value }))}
          onSelectAll={() => {
            const all: Record<string, boolean> = {}
            for (const p of dialogProposals) for (const c of p.changes) all[c.key] = true
            setFieldSelections(all)
          }}
          onDeselectAll={() => {
            const none: Record<string, boolean> = {}
            for (const p of dialogProposals) for (const c of p.changes) none[c.key] = false
            setFieldSelections(none)
          }}
          onApply={() => void handleApplyEnrich()}
          onSkip={() => {
            setEnrichDialogOpen(false)
            setEnrichProposal(null)
          }}
          isApplying={isApplyingEnrich}
        />
      )}
    </div>
    </div>
  )
}
