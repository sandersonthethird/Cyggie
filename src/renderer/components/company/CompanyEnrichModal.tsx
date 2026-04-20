/**
 * CompanyEnhanceModal — multi-step wizard for enhancing a company profile
 * from an external file (PDF or URL).
 *
 * Flow:
 *   source    → PitchDeckSourceInput (pick file or URL)
 *   extracting → spinner while COMPANY_PITCH_DECK_INGEST runs
 *   options   → output checkboxes (note always on, fields, sync, memo)
 *   [fields dialog] → EnrichmentProposalDialog if updateFields checked
 *   processing → spinner while COMPANY_ANALYZE_FILE or ADD_PITCH_DECK_COMPANY runs
 *   done      → per-action ✓ / ⚠ results
 *
 * Self-contained: CompanyDetail only passes open/company/onClose/onComplete.
 * All enrichment state lives here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDetail } from '../../../shared/types/company'
import type { PitchDeckExtractionResult } from '../../../shared/types/pitch-deck'
import type { DigestSection, PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import { ALL_SECTIONS, SECTION_LABELS } from '../partner-meeting/AddToSyncModal'
import type { CompanySummaryUpdateChange, CompanySummaryUpdatePayload } from '../../../shared/types/summary'
import { EnrichmentProposalDialog } from '../enrichment/EnrichmentProposalDialog'
import type { EnrichmentEntityProposal } from '../enrichment/EnrichmentProposalDialog'
import { PitchDeckSourceInput } from './PitchDeckSourceInput'
import { companyEnhancedAtKey } from '../../../shared/utils/enrichment-keys'
import { api } from '../../api'
import styles from './CompanyEnhanceModal.module.css'

type Step = 'source' | 'extracting' | 'options' | 'fields' | 'processing' | 'done'

type ActionResult = 'ok' | 'failed' | 'skipped'

interface EnhanceResults {
  note: ActionResult
  noteId: string | null
  fields: ActionResult
  sync: ActionResult | 'partial'  // 'partial' = added to sync but brief not generated
}

interface CompanyEnhanceModalProps {
  open: boolean
  company: CompanyDetail
  onClose: () => void
  /** Called when done — noteId is non-null if a note was successfully created */
  onComplete: (noteId: string | null) => void
}

export function CompanyEnhanceModal({
  open,
  company,
  onClose,
  onComplete,
}: CompanyEnhanceModalProps) {
  const [step, setStep] = useState<Step>('source')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [extractionResult, setExtractionResult] = useState<PitchDeckExtractionResult | null>(null)

  // Active digest — fetched on mount to decide whether to show sync option
  const [activeDigest, setActiveDigest] = useState<{ id: string; items?: PartnerMeetingItem[] } | null | 'loading'>('loading')
  const digestItem = useMemo(() => {
    if (!activeDigest || activeDigest === 'loading') return null
    return activeDigest.items?.find(i => i.companyId === company.id) ?? null
  }, [activeDigest, company.id])
  const hasActiveDigest = activeDigest !== 'loading' && activeDigest !== null

  // Output options
  const [updateFields, setUpdateFields] = useState(true)
  const [addToSync, setAddToSync] = useState(true)
  const [syncSection, setSyncSection] = useState<DigestSection>('new_deals')
  const [updateMemo, setUpdateMemo] = useState(false)

  // Field proposal state (mirrors CompanyDetail enrichment logic)
  const [enrichProposal, setEnrichProposal] = useState<{
    companyId: string
    companyName: string
    updates: CompanySummaryUpdatePayload
    changes: CompanySummaryUpdateChange[]
  } | null>(null)
  const [fieldSelections, setFieldSelections] = useState<Record<string, boolean>>({})
  const [isApplyingFields, setIsApplyingFields] = useState(false)

  // Done results
  const [results, setResults] = useState<EnhanceResults | null>(null)

  useEffect(() => {
    if (!open) return
    api.invoke<{ id: string; items?: PartnerMeetingItem[] }>(IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE)
      .then(digest => setActiveDigest(digest ?? null))
      .catch(() => setActiveDigest(null))
  }, [open])

  function reset() {
    setStep('source')
    setErrorMsg(null)
    setExtractionResult(null)
    setUpdateFields(true)
    setAddToSync(true)
    setUpdateMemo(false)
    setEnrichProposal(null)
    setFieldSelections({})
    setResults(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  // Build field proposals from extraction result vs current company values
  function buildFieldProposal(result: PitchDeckExtractionResult) {
    const changes: CompanySummaryUpdateChange[] = []
    const updates: CompanySummaryUpdatePayload = {}

    function addChange(field: string, from: string | number | null, to: string | number | null) {
      if (to != null && to !== '' && to !== from) {
        changes.push({ field, from, to })
        ;(updates as Record<string, unknown>)[field] = to
      }
    }

    addChange('description',        company.description ?? null,        result.description)
    addChange('round',              company.round ?? null,              result.round)
    addChange('raiseSize',          company.raiseSize ?? null,          result.raiseSize)
    addChange('postMoneyValuation', company.postMoneyValuation ?? null, result.postMoneyValuation)
    addChange('city',               company.city ?? null,               result.city)
    addChange('state',              company.state ?? null,              result.state)

    if (changes.length === 0) return null

    return {
      companyId: company.id,
      companyName: company.canonicalName,
      updates,
      changes,
    }
  }

  function handleExtractionResult(result: PitchDeckExtractionResult) {
    setExtractionResult(result)
    const proposal = buildFieldProposal(result)
    if (proposal) {
      const selections: Record<string, boolean> = {}
      for (const c of proposal.changes) selections[`${company.id}:${c.field}`] = true
      setEnrichProposal(proposal)
      setFieldSelections(selections)
    } else {
      setEnrichProposal(null)
    }
    setStep('options')
  }

  // Called after user clicks "Run" on options step
  async function handleRun() {
    if (!extractionResult) return

    // If fields checkbox is on and we have proposals, show the field review dialog first
    if (updateFields && enrichProposal) {
      setStep('fields')
      return
    }

    await runEnhancement(null)
  }

  // Called after field dialog resolves (apply or skip)
  async function handleFieldsApplied(applied: boolean) {
    setStep('processing')
    await runEnhancement(applied ? fieldSelections : null)
  }

  async function runEnhancement(appliedFieldSelections: Record<string, boolean> | null) {
    if (!extractionResult) return
    setStep('processing')

    const r: EnhanceResults = { note: 'skipped', noteId: null, fields: 'skipped', sync: 'skipped' }

    // Apply fields if confirmed
    if (appliedFieldSelections !== null && enrichProposal) {
      setIsApplyingFields(true)
      try {
        const selectedFields = new Set(
          Object.entries(appliedFieldSelections)
            .filter(([, v]) => v !== false)
            .map(([k]) => k.replace(`${company.id}:`, ''))
        )
        const builtinFields = ['description', 'round', 'raiseSize', 'postMoneyValuation', 'city', 'state'] as const
        const filteredUpdates: Record<string, unknown> = {}
        for (const field of builtinFields) {
          if (selectedFields.has(field) && (enrichProposal.updates as Record<string, unknown>)[field] !== undefined) {
            filteredUpdates[field] = (enrichProposal.updates as Record<string, unknown>)[field]
          }
        }
        if (Object.keys(filteredUpdates).length > 0) {
          await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, filteredUpdates)
        }
        r.fields = 'ok'
      } catch (err) {
        console.error('[CompanyEnhanceModal] field apply failed:', err)
        r.fields = 'failed'
      } finally {
        setIsApplyingFields(false)
      }
    }

    // Note + optional sync
    const shouldAddToSync = addToSync && hasActiveDigest
    try {
      if (shouldAddToSync) {
        const result = await api.invoke<{ noteId: string | null; hasBrief: boolean } | null>(
          IPC_CHANNELS.PARTNER_MEETING_ADD_PITCH_DECK_COMPANY,
          company.id,
          extractionResult,
          syncSection
        )
        r.noteId = result?.noteId ?? null
        r.note = r.noteId ? 'ok' : 'failed'
        r.sync = result !== null
          ? (result.hasBrief ? 'ok' : 'partial')
          : 'failed'
      } else {
        const result = await api.invoke<{ noteId: string | null; noteCreatedAt?: string; error?: string }>(
          IPC_CHANNELS.COMPANY_ANALYZE_FILE,
          company.id,
          extractionResult
        )
        if (result.noteId) {
          r.note = 'ok'
          r.noteId = result.noteId
          if (result.noteCreatedAt) {
            localStorage.setItem(companyEnhancedAtKey(company.id), result.noteCreatedAt)
          }
        } else {
          r.note = 'failed'
        }
        r.sync = 'skipped'
      }
    } catch (err) {
      console.error('[CompanyEnhanceModal] note/sync failed:', err)
      r.note = 'failed'
      if (shouldAddToSync) r.sync = 'failed'
    }

    // Memo — not yet wired; just navigate to memo tab
    if (updateMemo) {
      r.note = r.note // unchanged
    }

    setResults(r)
    setStep('done')

    // Store last-enhanced timestamp
    if (r.note === 'ok') {
      localStorage.setItem(companyEnhancedAtKey(company.id), new Date().toISOString())
    }
  }

  const dialogProposals = useMemo((): EnrichmentEntityProposal[] => {
    if (!enrichProposal) return []
    return [{
      entityId: company.id,
      entityName: enrichProposal.companyName,
      changes: enrichProposal.changes.map(c => ({
        key: `${company.id}:${c.field}`,
        label: c.field,
        from: c.from != null ? String(c.from) : null,
        to: String(c.to),
      })),
    }]
  }, [enrichProposal, company.id])

  if (!open) return null

  const syncCheckboxLabel = digestItem ? 'Update Partner Sync entry' : 'Add to Partner Sync'

  return createPortal(
    <>
      <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && handleClose()}>
        <div className={styles.modal}>
          {/* Header */}
          <div className={styles.header}>
            <h3 className={styles.title}>
              {step === 'source'     && 'Enhance from file'}
              {step === 'extracting' && 'Extracting…'}
              {step === 'options'    && 'What to update'}
              {step === 'fields'     && 'Review field updates'}
              {step === 'processing' && 'Analyzing…'}
              {step === 'done'       && 'Done'}
            </h3>
            <button className={styles.closeBtn} onClick={handleClose} aria-label="Close">×</button>
          </div>

          {/* Source picker */}
          {step === 'source' && (
            <PitchDeckSourceInput
              companyId={company.id}
              onIngestStart={() => setStep('extracting')}
              onResult={handleExtractionResult}
              onError={(msg) => {
                setErrorMsg(msg)
                setStep('source')
              }}
            />
          )}

          {/* Extraction error banner */}
          {step === 'source' && errorMsg && (
            <div className={styles.errorBanner}>⚠ {errorMsg}</div>
          )}

          {/* Extracting spinner */}
          {step === 'extracting' && (
            <div className={styles.loadingStep}>
              <div className={styles.spinner} />
              <p className={styles.loadingText}>Extracting company data…</p>
            </div>
          )}

          {/* Output options */}
          {step === 'options' && (
            <div className={styles.optionsStep}>
              <p className={styles.optionsLabel}>
                Found data from <strong>{extractionResult?.companyName ?? extractionResult?.sourceLabel ?? 'document'}</strong>.
                What would you like to do with it?
              </p>
              <div className={styles.optionsList}>
                {/* Create note — always on */}
                <label className={`${styles.option} ${styles.optionLocked}`}>
                  <input type="checkbox" checked readOnly />
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>Create a note</span>
                    <span className={styles.optionDesc}>Full VC analysis saved as a company note</span>
                  </span>
                </label>

                {/* Update fields */}
                <label className={`${styles.option} ${enrichProposal ? '' : styles.optionDisabled}`}>
                  <input
                    type="checkbox"
                    checked={updateFields && !!enrichProposal}
                    onChange={(e) => setUpdateFields(e.target.checked)}
                    disabled={!enrichProposal}
                  />
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>Update company fields</span>
                    <span className={styles.optionDesc}>
                      {enrichProposal
                        ? `${enrichProposal.changes.length} field${enrichProposal.changes.length !== 1 ? 's' : ''} available to update`
                        : 'No new field data found in this document'}
                    </span>
                  </span>
                </label>

                {/* Add to partner sync */}
                {hasActiveDigest && (
                  <label className={styles.option}>
                    <input
                      type="checkbox"
                      checked={addToSync}
                      onChange={(e) => setAddToSync(e.target.checked)}
                    />
                    <span className={styles.optionText}>
                      <span className={styles.optionTitle}>{syncCheckboxLabel}</span>
                      <span className={styles.optionDesc}>AI-generated brief added to this week's digest</span>
                    </span>
                  </label>
                )}
                {hasActiveDigest && addToSync && (
                  <div className={styles.syncSectionRow}>
                    <label className={styles.syncSectionLabel}>Section</label>
                    <select
                      className={styles.syncSectionSelect}
                      value={syncSection}
                      onChange={(e) => setSyncSection(e.target.value as DigestSection)}
                    >
                      {ALL_SECTIONS.map(s => (
                        <option key={s} value={s}>{SECTION_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Update memo */}
                <label className={styles.option}>
                  <input
                    type="checkbox"
                    checked={updateMemo}
                    onChange={(e) => setUpdateMemo(e.target.checked)}
                  />
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>Update investment memo</span>
                    <span className={styles.optionDesc}>Navigate to Memo tab to regenerate</span>
                  </span>
                </label>
              </div>

              <div className={styles.footer}>
                <button className={styles.secondaryBtn} onClick={handleClose}>Cancel</button>
                <button className={styles.primaryBtn} onClick={() => void handleRun()}>
                  Run ▸
                </button>
              </div>
            </div>
          )}

          {/* Processing spinner */}
          {step === 'processing' && (
            <div className={styles.loadingStep}>
              <div className={styles.spinner} />
              <p className={styles.loadingText}>Analyzing document and saving results…</p>
            </div>
          )}

          {/* Done */}
          {step === 'done' && results && (
            <div className={styles.doneStep}>
              <div className={styles.resultsList}>
                {/* Note result */}
                <div className={`${styles.resultRow} ${results.note === 'ok' ? styles.resultOk : results.note === 'failed' ? styles.resultFailed : styles.resultSkipped}`}>
                  {results.note === 'ok' && <span className={styles.resultIcon}>✓</span>}
                  {results.note === 'failed' && <span className={styles.resultIcon}>⚠</span>}
                  <span className={styles.resultLabel}>
                    {results.note === 'ok' && 'Note created'}
                    {results.note === 'failed' && 'Note creation failed — check AI provider settings'}
                    {results.note === 'skipped' && 'Note skipped'}
                  </span>
                </div>

                {/* Fields result */}
                {results.fields !== 'skipped' && (
                  <div className={`${styles.resultRow} ${results.fields === 'ok' ? styles.resultOk : styles.resultFailed}`}>
                    {results.fields === 'ok' && <span className={styles.resultIcon}>✓</span>}
                    {results.fields === 'failed' && <span className={styles.resultIcon}>⚠</span>}
                    <span className={styles.resultLabel}>
                      {results.fields === 'ok' ? 'Company fields updated' : 'Field update failed'}
                    </span>
                  </div>
                )}

                {/* Sync result */}
                {results.sync !== 'skipped' && (
                  <div className={`${styles.resultRow} ${
                    results.sync === 'ok' ? styles.resultOk
                    : results.sync === 'partial' ? styles.resultPartial
                    : styles.resultFailed
                  }`}>
                    {results.sync === 'ok' && <span className={styles.resultIcon}>✓</span>}
                    {results.sync === 'partial' && <span className={styles.resultIcon}>⚠</span>}
                    {results.sync === 'failed' && <span className={styles.resultIcon}>⚠</span>}
                    <span className={styles.resultLabel}>
                      {results.sync === 'ok' && (digestItem ? 'Partner Sync entry updated' : 'Added to Partner Sync')}
                      {results.sync === 'partial' && 'Added to Partner Sync (brief not generated — check note for details)'}
                      {results.sync === 'failed' && 'Partner Sync update failed'}
                    </span>
                  </div>
                )}

                {/* Memo note */}
                {updateMemo && (
                  <div className={`${styles.resultRow} ${styles.resultSkipped}`}>
                    <span className={styles.resultIcon}>→</span>
                    <span className={styles.resultLabel}>Navigate to Memo tab to regenerate</span>
                  </div>
                )}
              </div>

              <div className={styles.footer}>
                <button
                  className={styles.primaryBtn}
                  onClick={() => {
                    const noteId = results.noteId
                    handleClose()
                    onComplete(noteId)
                  }}
                >
                  {results.note === 'ok' ? 'View Note ▸' : 'Close'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Field proposals dialog — shown on 'fields' step, rendered outside modal */}
      {step === 'fields' && enrichProposal && (
        <EnrichmentProposalDialog
          open={true}
          title="Review field updates"
          subtitle="New information was found in this document. Select which updates to apply."
          proposals={dialogProposals}
          fieldSelections={fieldSelections}
          onFieldToggle={(key, value) => setFieldSelections(prev => ({ ...prev, [key]: value }))}
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
          onApply={() => void handleFieldsApplied(true)}
          onSkip={() => void handleFieldsApplied(false)}
          isApplying={isApplyingFields}
        />
      )}
    </>,
    document.body
  )
}
