import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CompanyDetail as CompanyDetailType, CompanyMeetingRef } from '../../shared/types/company'
import type { CompanySummaryUpdateProposal } from '../../shared/types/summary'
import { companyEnrichedAtKey } from '../../shared/utils/enrichment-keys'
import { CompanyPropertiesPanel } from '../components/company/CompanyPropertiesPanel'
import { CompanyTimeline } from '../components/company/CompanyTimeline'
import { CompanyContacts } from '../components/company/CompanyContacts'
import { CompanyNotes } from '../components/company/CompanyNotes'
import { CompanyMemo } from '../components/company/CompanyMemo'
import { CompanyFiles } from '../components/company/CompanyFiles'
import { CompanyDecisions } from '../components/company/CompanyDecisions'
import { EnrichmentProposalDialog } from '../components/enrichment/EnrichmentProposalDialog'
import type { EnrichmentEntityProposal } from '../components/enrichment/EnrichmentProposalDialog'
import ChatInterface from '../components/chat/ChatInterface'
import { usePanelResize } from '../hooks/usePanelResize'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'timeline' | 'contacts' | 'notes' | 'memo' | 'files' | 'decisions'

export default function CompanyDetail() {
  const { companyId: id } = useParams<{ companyId: string }>()
  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<CompanyTab>('timeline')
  const [timelineKey, setTimelineKey] = useState(0)
  const { leftWidth, dividerProps } = usePanelResize({ defaultWidth: 360 })

  // Meetings (for enrichment)
  const [companyMeetings, setCompanyMeetings] = useState<CompanyMeetingRef[]>([])

  // Enrichment state
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

  // Fetch meetings when id or company loads
  useEffect(() => {
    if (!id) return
    window.api
      .invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, id)
      .then((data) => setCompanyMeetings(Array.isArray(data) ? data : []))
      .catch(() => setCompanyMeetings([]))
  }, [id])

  const summarizedMeetings = useMemo(
    () => companyMeetings.filter((m) => m.status === 'summarized'),
    [companyMeetings]
  )

  const showEnrichBanner = useMemo(() => {
    if (summarizedMeetings.length === 0) return false
    if (!lastEnrichedAt) return true
    return summarizedMeetings.some((m) => m.date > lastEnrichedAt)
  }, [summarizedMeetings, lastEnrichedAt])

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
    // Increment timelineKey when pipelineStage changes so the timeline refreshes
    // to show the auto-logged Stage Change entry
    if ('pipelineStage' in updates) {
      setTimelineKey((k) => k + 1)
    }
  }

  const handleEnrichFromMeetings = useCallback(async () => {
    if (!id || summarizedMeetings.length === 0) return
    setIsLoadingEnrich(true)
    setEnrichError(null)
    try {
      const proposal = await window.api.invoke<CompanySummaryUpdateProposal | null>(
        IPC_CHANNELS.COMPANY_ENRICH_FROM_MEETINGS,
        summarizedMeetings.map((m) => m.id),
        id
      )
      if (proposal && (proposal.changes.length > 0 || (proposal.customFieldUpdates?.length ?? 0) > 0)) {
        // Initialize all fields as selected
        const selections: Record<string, boolean> = {}
        for (const change of proposal.changes) {
          selections[`${id}:${change.field}`] = true
        }
        for (const cfu of proposal.customFieldUpdates ?? []) {
          selections[`${id}:${cfu.label}`] = true
        }
        setFieldSelections(selections)
        setEnrichProposal(proposal)
        setEnrichDialogOpen(true)
      } else {
        // No proposals — mark as enriched so banner hides
        const enrichedAt = new Date().toISOString()
        localStorage.setItem(companyEnrichedAtKey(id), enrichedAt)
        setLastEnrichedAt(enrichedAt)
      }
    } catch (err) {
      console.error('[CompanyDetail] Failed to load enrichment proposals:', err)
      setEnrichError('Could not load enrichment — please try again')
      setTimeout(() => setEnrichError(null), 4000)
    } finally {
      setIsLoadingEnrich(false)
    }
  }, [summarizedMeetings, id])

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
      // Apply selected built-in field updates
      const builtinFields = ['description', 'round', 'raiseSize', 'postMoneyValuation', 'city', 'state', 'pipelineStage'] as const
      const filteredUpdates: Record<string, unknown> = {}
      for (const field of builtinFields) {
        if (selectedFields.has(field) && enrichProposal.updates[field] !== undefined) {
          filteredUpdates[field] = enrichProposal.updates[field]
        }
      }

      // Recompute fieldSources: only for selected built-in fields
      if (enrichProposal.updates.fieldSources) {
        try {
          const allSources = JSON.parse(enrichProposal.updates.fieldSources) as Record<string, string>
          const filteredSources: Record<string, string> = {}
          for (const [field, meetingId] of Object.entries(allSources)) {
            if (selectedFields.has(field)) filteredSources[field] = meetingId
          }
          // Merge with existing fieldSources
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

      // Apply selected custom field updates
      for (const cfu of enrichProposal.customFieldUpdates ?? []) {
        if (!selectedFields.has(cfu.label)) continue
        await window.api.invoke(
          IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE,
          'company',
          id,
          cfu.fieldDefinitionId,
          cfu.newValue
        )
      }

      // Refetch company to reflect updated values
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

  // Build proposals for the shared dialog
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
    return <div className={styles.loading}>Loading…</div>
  }
  if (!company) {
    return <div className={styles.notFound}>Company not found.</div>
  }

  const tabs: Array<{ key: CompanyTab; label: string; badge?: number }> = [
    {
      key: 'timeline',
      label: 'Timeline',
      badge: (company.meetingCount || 0) + (company.emailCount || 0) + (company.noteCount || 0) || undefined
    },
    { key: 'contacts', label: 'Contacts', badge: company.contactCount || undefined },
    { key: 'notes', label: 'Notes', badge: company.noteCount || undefined },
    { key: 'decisions', label: 'Decisions' },
    { key: 'memo', label: 'Memo' },
    { key: 'files', label: 'Files' }
  ]

  return (
    <div className={styles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr` }}>
      {/* Left panel — properties */}
      <div className={styles.leftPanel}>
        <CompanyPropertiesPanel
          company={company}
          onUpdate={handleUpdate}
          showEnrichBanner={showEnrichBanner}
          enrichMeetingCount={summarizedMeetings.length}
          fieldSources={parsedFieldSources}
          onEnrichFromMeetings={() => void handleEnrichFromMeetings()}
          isLoadingEnrich={isLoadingEnrich}
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

      <ChatInterface
        floating
        companyId={company.id}
        entityName={company.canonicalName}
        placeholder={`Ask about ${company.canonicalName}…`}
      />

      {/* Resizable divider */}
      <div className={styles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={styles.rightPanel}>
        <div className={styles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={styles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* All tabs always mounted (CSS hide/show) to preserve CompanyMemo draft state */}
        <div className={styles.tabContent}>
          <div className={activeTab !== 'timeline' ? styles.hidden : ''}>
            <CompanyTimeline companyId={company.id} refreshKey={timelineKey} />
          </div>
          <div className={activeTab !== 'contacts' ? styles.hidden : ''}>
            <CompanyContacts companyId={company.id} />
          </div>
          <div className={activeTab !== 'notes' ? styles.hidden : ''}>
            <CompanyNotes companyId={company.id} />
          </div>
          <div className={activeTab !== 'decisions' ? styles.hidden : ''}>
            <CompanyDecisions companyId={company.id} />
          </div>
          <div className={activeTab !== 'memo' ? styles.hidden : ''}>
            <CompanyMemo companyId={company.id} />
          </div>
          <div className={activeTab !== 'files' ? styles.hidden : ''}>
            <CompanyFiles companyId={company.id} />
          </div>
        </div>
      </div>

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
  )
}
