/**
 * NewCompanyModal — shared company creation flow with pitch deck ingestion.
 *
 * Steps (state machine):
 *   source-picker → manual-form | pdf-loading | url-input
 *   pdf-loading   → review-form | error
 *   url-input     → url-loading → review-form | error
 *   review-form   → dedup? → creating → (onCreated callback)
 *   error         → source-picker (try again)
 *
 * Used by Companies.tsx, Pipeline.tsx, and (for existing-company enrichment)
 * CompanyDetail.tsx. When `companyId` is provided the dedup check is skipped
 * and results are passed back via `onIngestResult` for use with
 * EnrichmentProposalDialog.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import {
  detectDeckPlatform,
  type PitchDeckExtractionResult,
  type PitchDeckIngestResult,
} from '../../../shared/types/pitch-deck'
import type {
  CompanyEntityType,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound,
  CompanySummary,
} from '../../../shared/types/company'
import type { PartnerMeetingDigest } from '../../../shared/types/partner-meeting'
import { api } from '../../api'
import styles from './NewCompanyModal.module.css'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Maps a company's pipeline stage to the appropriate digest section. */
function stageToDigestSection(stage: string | null): 'new_deals' | 'existing_deals' | 'portfolio_updates' | 'passing' {
  if (stage === 'diligence' || stage === 'decision') return 'existing_deals'
  if (stage === 'documentation') return 'portfolio_updates'
  if (stage === 'pass') return 'passing'
  return 'new_deals'
}

// ── Constants (reused from Companies.tsx) ───────────────────────────────────

const ENTITY_TYPES: { value: CompanyEntityType; label: string }[] = [
  { value: 'startup',      label: 'Startup'       },
  { value: 'vc_fund',      label: 'VC Fund'       },
  { value: 'family_office',label: 'Family Office' },
  { value: 'angel',        label: 'Angel'         },
  { value: 'accelerator',  label: 'Accelerator'   },
  { value: 'corporate',    label: 'Corporate'     },
  { value: 'other',        label: 'Other'         },
]

const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening',     label: 'Screening'     },
  { value: 'diligence',     label: 'Diligence'     },
  { value: 'decision',      label: 'Decision'      },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass',          label: 'Pass'          },
]

const PRIORITIES: { value: CompanyPriority; label: string }[] = [
  { value: 'high',   label: 'High'   },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low'    },
]

const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed',       label: 'Pre-Seed'       },
  { value: 'seed',           label: 'Seed'           },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a',       label: 'Series A'       },
  { value: 'series_b',       label: 'Series B'       },
]

// ── Types ───────────────────────────────────────────────────────────────────

interface CreateFormState {
  name: string
  description: string
  domain: string
  city: string
  state: string
  entityType: CompanyEntityType
  pipelineStage: CompanyPipelineStage | ''
  priority: CompanyPriority | ''
  round: CompanyRound | ''
  postMoney: string
  raiseSize: string
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  description: '',
  domain: '',
  city: '',
  state: '',
  entityType: 'startup',
  pipelineStage: '',
  priority: '',
  round: '',
  postMoney: '',
  raiseSize: '',
}

type Step =
  | 'source-picker'
  | 'url-input'
  | 'loading'
  | 'review-form'
  | 'dedup'
  | 'creating'
  | 'error'

// ── Props ───────────────────────────────────────────────────────────────────

export interface NewCompanyModalProps {
  open: boolean
  defaultStage?: CompanyPipelineStage
  /** Pre-load a PDF path (e.g. from Pipeline drag-drop) */
  initialPdfPath?: string
  /** Called after company is successfully created */
  onCreated: (company: CompanySummary) => void
  onClose: () => void
}

// ── Component ───────────────────────────────────────────────────────────────

export default function NewCompanyModal({
  open,
  defaultStage,
  initialPdfPath,
  onCreated,
  onClose,
}: NewCompanyModalProps) {
  const [step, setStep] = useState<Step>('source-picker')
  const [formState, setFormState] = useState<CreateFormState>({ ...EMPTY_FORM, pipelineStage: defaultStage ?? '' })
  const [extractedResult, setExtractedResult] = useState<PitchDeckExtractionResult | null>(null)
  const [dedupMatch, setDedupMatch] = useState<{ companyId: string; companyName: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [addToPartnerSync, setAddToPartnerSync] = useState(true)

  // URL step state
  const [urlValue, setUrlValue] = useState('')
  const [emailValue, setEmailValue] = useState('')
  const [passwordValue, setPasswordValue] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [savedEmail, setSavedEmail] = useState<string | null>(null)

  const urlInputRef = useRef<HTMLInputElement>(null)

  const detectedPlatform = urlValue ? detectDeckPlatform(urlValue) : null

  // Load saved DocSend email on open
  useEffect(() => {
    if (!open) return
    api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'pitchDeckEmail')
      .then((v) => setSavedEmail(v ?? null))
      .catch(() => {})
  }, [open])

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!open) return
    setStep(initialPdfPath ? 'loading' : 'source-picker')
    setFormState({ ...EMPTY_FORM, pipelineStage: defaultStage ?? '' })
    setExtractedResult(null)
    setDedupMatch(null)
    setErrorMsg(null)
    setUrlValue('')
    setEmailValue('')
    setPasswordValue('')
    setShowPassword(false)
    setAddToPartnerSync(true)

    if (initialPdfPath) {
      void ingestPdf(initialPdfPath)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPdfPath])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const patchForm = (patch: Partial<CreateFormState>) =>
    setFormState((prev) => ({ ...prev, ...patch }))

  function applyExtractionToForm(result: PitchDeckExtractionResult) {
    setExtractedResult(result)
    setFormState((prev) => ({
      ...prev,
      name:         result.companyName ?? prev.name,
      description:  result.description ?? prev.description,
      domain:       result.domain ?? prev.domain,
      city:         result.city ?? prev.city,
      state:        result.state ?? prev.state,
      entityType:   (result.entityType as CompanyEntityType) ?? prev.entityType,
      pipelineStage: prev.pipelineStage || defaultStage || '',
      round:        (result.round as CompanyRound) ?? prev.round,
      raiseSize:    result.raiseSize != null ? String(result.raiseSize) : prev.raiseSize,
      postMoney:    result.postMoneyValuation != null ? String(result.postMoneyValuation) : prev.postMoney,
    }))
  }

  async function handleIngestResult(raw: PitchDeckIngestResult) {
    if ('error' in raw) {
      setErrorMsg(raw.error)
      setStep('error')
      return
    }
    applyExtractionToForm(raw.result)
    if (raw.existingMatch) {
      setDedupMatch(raw.existingMatch)
      setStep('dedup')
    } else {
      setStep('review-form')
    }
  }

  // ── PDF path ──────────────────────────────────────────────────────────────

  async function handlePickPdf() {
    const path = await api.invoke<string | null>(IPC_CHANNELS.COMPANY_PITCH_DECK_OPEN_DIALOG)
    if (!path) return
    await ingestPdf(path)
  }

  async function ingestPdf(path: string) {
    setStep('loading')
    try {
      const raw = await api.invoke<PitchDeckIngestResult>(IPC_CHANNELS.COMPANY_PITCH_DECK_INGEST, {
        source: { type: 'pdf', path },
      })
      await handleIngestResult(raw)
    } catch {
      setErrorMsg('An unexpected error occurred — please try again')
      setStep('error')
    }
  }

  // ── URL path ──────────────────────────────────────────────────────────────

  async function handleIngestUrl() {
    const trimmedUrl = urlValue.trim()
    if (!trimmedUrl) return
    setStep('loading')
    // Save email if different from saved
    const resolvedEmail = emailValue.trim() || undefined
    try {
      const raw = await api.invoke<PitchDeckIngestResult>(IPC_CHANNELS.COMPANY_PITCH_DECK_INGEST, {
        source: {
          type: 'url',
          url: trimmedUrl,
          email: resolvedEmail,
          password: passwordValue.trim() || undefined,
        },
      })
      await handleIngestResult(raw)
    } catch {
      setErrorMsg('An unexpected error occurred — please try again')
      setStep('error')
    }
  }

  // ── Company creation ──────────────────────────────────────────────────────

  async function handleCreate() {
    if (!formState.name.trim()) return
    setStep('creating')
    try {
      // Primary contact from CEO founder (or first founder if no CEO)
      const founders = extractedResult?.founders ?? []
      const ceoFounder = founders.find((f) => f.isCeo) ?? founders[0] ?? null
      const primaryContact = ceoFounder?.name
        ? { fullName: ceoFounder.name, email: ceoFounder.email ?? undefined }
        : undefined

      const created = await api.invoke<CompanySummary>(IPC_CHANNELS.COMPANY_CREATE, {
        canonicalName:  formState.name.trim(),
        description:    formState.description.trim() || null,
        primaryDomain:  formState.domain.trim() || null,
        entityType:     formState.entityType,
        primaryContact,
      })

      const updates: Record<string, unknown> = {}
      if (formState.city.trim())        updates.city = formState.city.trim()
      if (formState.state.trim())       updates.state = formState.state.trim()
      if (formState.pipelineStage)      updates.pipelineStage = formState.pipelineStage
      if (formState.priority)           updates.priority = formState.priority
      if (formState.round)              updates.round = formState.round
      if (formState.postMoney.trim())   updates.postMoneyValuation = Number(formState.postMoney)
      if (formState.raiseSize.trim())   updates.raiseSize = Number(formState.raiseSize)
      if (Object.keys(updates).length > 0) {
        await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, updates)
      }

      // Create additional founders (skip primary — already created via primaryContact)
      const additionalFounders = founders.filter(
        (f) => f !== (ceoFounder ?? null) && f.name?.trim()
      )
      for (const founder of additionalFounders) {
        try {
          await api.invoke(IPC_CHANNELS.CONTACT_CREATE, {
            fullName:    founder.name,
            email:       founder.email ?? null,
            title:       founder.title ?? null,
            companyName: created.canonicalName,
          })
        } catch {
          // Non-fatal — continue with remaining founders
        }
      }

      // Optionally add to the active partner sync digest. Fire-and-forget — does not block navigation.
      if (addToPartnerSync) {
        const companyName = created.canonicalName
        if (extractedResult) {
          // Deck path: runs LLM analysis + note creation + brief extraction
          api.invoke(IPC_CHANNELS.PARTNER_MEETING_ADD_PITCH_DECK_COMPANY, created.id, extractedResult)
            .then(() => {
              new Notification('Added to partner sync', {
                body: `${companyName} was added to this week's partner sync with an AI-generated brief.`,
                silent: true,
              })
            })
            .catch((err: unknown) => console.error('[NewCompanyModal] pitch deck partner sync failed:', err))
        } else {
          // Manual path: add to active digest with no brief, then notify
          api.invoke<PartnerMeetingDigest | null>(IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE)
            .then((digest) => {
              if (!digest) return
              return api.invoke(IPC_CHANNELS.PARTNER_MEETING_ITEM_ADD, digest.id, {
                companyId: created.id,
                section: stageToDigestSection(formState.pipelineStage || null),
              }).then(() => {
                new Notification('Added to partner sync', {
                  body: `${companyName} was added to this week's partner sync.`,
                  silent: true,
                })
              })
            })
            .catch((err: unknown) => console.error('[NewCompanyModal] manual partner sync add failed:', err))
        }
      }

      onCreated(created)
      onClose()
    } catch (err) {
      setErrorMsg(String(err))
      setStep('error')
    }
  }

  if (!open) return null

  // ── Render ────────────────────────────────────────────────────────────────

  return createPortal(
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>
            {step === 'source-picker' && 'Add Company'}
            {step === 'url-input'     && 'Ingest from Website'}
            {step === 'loading'       && 'Extracting…'}
            {step === 'review-form'   && 'Review & Create'}
            {step === 'dedup'         && 'Company Already Exists'}
            {step === 'creating'      && 'Creating…'}
            {step === 'error'         && 'Extraction Failed'}
          </h3>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Source picker */}
        {step === 'source-picker' && (
          <div className={styles.sourcePicker}>
            <p className={styles.sourcePickerLabel}>How would you like to add this company?</p>
            <div className={styles.sourceOptions}>
              <button className={styles.sourceOption} onClick={() => setStep('review-form')}>
                <span className={styles.sourceOptionIcon}>✏️</span>
                <span className={styles.sourceOptionText}>
                  <span className={styles.sourceOptionTitle}>Fill manually</span>
                  <span className={styles.sourceOptionDesc}>Enter company details yourself</span>
                </span>
              </button>
              <button className={styles.sourceOption} onClick={handlePickPdf}>
                <span className={styles.sourceOptionIcon}>📄</span>
                <span className={styles.sourceOptionText}>
                  <span className={styles.sourceOptionTitle}>Pitch deck PDF</span>
                  <span className={styles.sourceOptionDesc}>Choose a PDF — AI extracts company data automatically</span>
                </span>
              </button>
              <button className={styles.sourceOption} onClick={() => { setStep('url-input'); setTimeout(() => urlInputRef.current?.focus(), 50) }}>
                <span className={styles.sourceOptionIcon}>🔗</span>
                <span className={styles.sourceOptionText}>
                  <span className={styles.sourceOptionTitle}>Website or link</span>
                  <span className={styles.sourceOptionDesc}>DocSend, company website, Notion, etc.</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* URL input step */}
        {step === 'url-input' && (
          <div className={styles.urlStep}>
            {detectedPlatform && (
              <span className={styles.platformBadge}>
                {detectedPlatform.name} detected
              </span>
            )}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>URL</label>
              <input
                ref={urlInputRef}
                className={styles.input}
                type="url"
                placeholder="https://docsend.com/view/..."
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleIngestUrl()}
              />
            </div>
            {(detectedPlatform?.requiresEmail || emailValue) && (
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Email for access</label>
                {savedEmail && !emailValue && (
                  <p className={styles.emailHintSaved}>
                    Saved: {savedEmail} — change below if the deck was forwarded to a different address
                  </p>
                )}
                <input
                  className={styles.input}
                  type="email"
                  placeholder={savedEmail ?? 'your@email.com'}
                  value={emailValue}
                  onChange={(e) => setEmailValue(e.target.value)}
                />
                <p className={styles.emailHint}>
                  Use your own email — or the address the deck was sent to if different.
                </p>
              </div>
            )}
            {showPassword && (
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Password (optional)</label>
                <input
                  className={styles.input}
                  type="password"
                  value={passwordValue}
                  onChange={(e) => setPasswordValue(e.target.value)}
                />
              </div>
            )}
            {!showPassword && (
              <button className={styles.passwordToggle} onClick={() => setShowPassword(true)}>
                + Need to enter a password?
              </button>
            )}
          </div>
        )}

        {/* Loading */}
        {(step === 'loading' || step === 'creating') && (
          <div className={styles.loadingStep}>
            <div className={styles.spinner} />
            <p className={styles.loadingText}>
              {step === 'loading' ? 'AI is reading the deck…' : 'Creating company…'}
            </p>
          </div>
        )}

        {/* Error */}
        {step === 'error' && (
          <div className={styles.errorStep}>
            <span className={styles.errorIcon}>⚠️</span>
            <p className={styles.errorText}>{errorMsg}</p>
          </div>
        )}

        {/* Dedup interstitial */}
        {step === 'dedup' && dedupMatch && (
          <div className={styles.dedupStep}>
            <div className={styles.dedupCard}>
              <p className={styles.dedupLabel}>Already in your pipeline</p>
              <p className={styles.dedupCompanyName}>{dedupMatch.companyName}</p>
              <p className={styles.dedupDesc}>
                This deck appears to be for a company that already exists. Would you like to update their profile instead of creating a duplicate?
              </p>
            </div>
          </div>
        )}

        {/* Review form */}
        {step === 'review-form' && (
          <div className={styles.reviewForm}>
            <div className={styles.formGrid}>
              <div className={styles.formFieldFull}>
                <label className={styles.formLabel}>Company Name *</label>
                <input
                  className={styles.input}
                  value={formState.name}
                  onChange={(e) => patchForm({ name: e.target.value })}
                  autoFocus={!formState.name}
                />
              </div>
              <div>
                <label className={styles.formLabel}>Domain</label>
                <input
                  className={styles.input}
                  placeholder="e.g. acme.com"
                  value={formState.domain}
                  onChange={(e) => patchForm({ domain: e.target.value })}
                />
              </div>
              <div>
                <label className={styles.formLabel}>City</label>
                <input
                  className={styles.input}
                  value={formState.city}
                  onChange={(e) => patchForm({ city: e.target.value })}
                />
              </div>
              <div>
                <label className={styles.formLabel}>State</label>
                <input
                  className={styles.input}
                  placeholder="e.g. CA"
                  value={formState.state}
                  onChange={(e) => patchForm({ state: e.target.value })}
                />
              </div>
              <div className={styles.formFieldFull}>
                <label className={styles.formLabel}>Description</label>
                <textarea
                  className={styles.textarea}
                  value={formState.description}
                  onChange={(e) => patchForm({ description: e.target.value })}
                />
              </div>
              <div>
                <label className={styles.formLabel}>Entity Type</label>
                <select
                  className={styles.select}
                  value={formState.entityType}
                  onChange={(e) => patchForm({ entityType: e.target.value as CompanyEntityType })}
                >
                  {ENTITY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={styles.formLabel}>Pipeline Stage</label>
                <select
                  className={styles.select}
                  value={formState.pipelineStage}
                  onChange={(e) => patchForm({ pipelineStage: e.target.value as CompanyPipelineStage | '' })}
                >
                  <option value="">None</option>
                  {STAGES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={styles.formLabel}>Round</label>
                <select
                  className={styles.select}
                  value={formState.round}
                  onChange={(e) => patchForm({ round: e.target.value as CompanyRound | '' })}
                >
                  <option value="">None</option>
                  {ROUNDS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={styles.formLabel}>Priority</label>
                <select
                  className={styles.select}
                  value={formState.priority}
                  onChange={(e) => patchForm({ priority: e.target.value as CompanyPriority | '' })}
                >
                  <option value="">None</option>
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={styles.formLabel}>Post Money ($M)</label>
                <input
                  className={styles.input}
                  type="number"
                  step="0.1"
                  value={formState.postMoney}
                  onChange={(e) => patchForm({ postMoney: e.target.value })}
                />
              </div>
              <div>
                <label className={styles.formLabel}>Raise Size ($M)</label>
                <input
                  className={styles.input}
                  type="number"
                  step="0.1"
                  value={formState.raiseSize}
                  onChange={(e) => patchForm({ raiseSize: e.target.value })}
                />
              </div>

              {/* Founders extracted from deck */}
              {(extractedResult?.founders.length ?? 0) > 0 && (
                <>
                  <div className={styles.sectionDivider}>Founders & Officers</div>
                  <div className={styles.foundersSection}>
                    {extractedResult!.founders.map((founder, i) => (
                      <div key={i} className={styles.founderRow}>
                        <span className={styles.founderName}>{founder.name}</span>
                        {founder.title && <span className={styles.founderTitle}>{founder.title}</span>}
                        {founder.email && <span className={styles.founderEmail}>{founder.email}</span>}
                        {founder.isCeo && <span className={styles.founderBadge}>Primary</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Partner sync opt-in */}
              <div className={styles.partnerSyncRow}>
                <label className={styles.partnerSyncLabel}>
                  <input
                    type="checkbox"
                    checked={addToPartnerSync}
                    onChange={(e) => setAddToPartnerSync(e.target.checked)}
                  />
                  Add to this week's partner sync (Screening)
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        {(step === 'source-picker' || step === 'url-input' || step === 'review-form' || step === 'dedup' || step === 'error') && (
          <div className={styles.footer}>
            {/* Back button */}
            {(step === 'url-input' || step === 'review-form' || step === 'error') && (
              <button className={styles.backBtn} onClick={() => setStep('source-picker')}>
                ← Back
              </button>
            )}
            {step === 'dedup' && (
              <button className={styles.backBtn} onClick={() => setStep('review-form')}>
                ← Back
              </button>
            )}

            {step === 'source-picker' && (
              <button className={styles.secondaryBtn} onClick={onClose}>Cancel</button>
            )}

            {step === 'url-input' && (
              <>
                <button className={styles.secondaryBtn} onClick={onClose}>Cancel</button>
                <button
                  className={styles.primaryBtn}
                  onClick={() => void handleIngestUrl()}
                  disabled={!urlValue.trim()}
                >
                  Extract
                </button>
              </>
            )}

            {step === 'review-form' && (
              <>
                <button className={styles.secondaryBtn} onClick={onClose}>Cancel</button>
                <button
                  className={styles.primaryBtn}
                  onClick={() => void handleCreate()}
                  disabled={!formState.name.trim()}
                >
                  Create Company
                </button>
              </>
            )}

            {step === 'dedup' && dedupMatch && (
              <>
                <button
                  className={styles.secondaryBtn}
                  onClick={() => { setDedupMatch(null); setStep('review-form') }}
                >
                  Create Anyway
                </button>
                <button
                  className={styles.primaryBtn}
                  onClick={() => {
                    // Navigate to existing company — caller handles this via onCreated
                    // We fake a CompanySummary with the matched ID so the caller navigates
                    onCreated({ id: dedupMatch.companyId, canonicalName: dedupMatch.companyName } as CompanySummary)
                    onClose()
                  }}
                >
                  Update {dedupMatch.companyName}
                </button>
              </>
            )}

            {step === 'error' && (
              <>
                <button className={styles.secondaryBtn} onClick={onClose}>Close</button>
                <button className={styles.primaryBtn} onClick={() => { setErrorMsg(null); setStep('source-picker') }}>
                  Try Again
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
