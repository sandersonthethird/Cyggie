/**
 * PitchDeckSourceInput — shared source picker form used by both
 * PitchDeckIngestModal (new company flow) and CompanyEnhanceModal (enhance existing).
 *
 * Renders two steps:
 *   'picker'    — PDF button + URL button
 *   'url-input' — URL field + optional email + optional password
 *
 * Calls onIngestStart() when ingestion begins, onResult() when it completes.
 */

import { useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import {
  detectDeckPlatform,
  type PitchDeckExtractionResult,
  type PitchDeckIngestResult,
} from '../../../shared/types/pitch-deck'
import { api } from '../../api'
import styles from './NewCompanyModal.module.css'

type SourceStep = 'picker' | 'url-input'

interface PitchDeckSourceInputProps {
  companyId?: string
  onIngestStart: () => void
  onResult: (result: PitchDeckExtractionResult) => void
  onError: (message: string) => void
  onBack?: () => void
}

export function PitchDeckSourceInput({
  companyId,
  onIngestStart,
  onResult,
  onError,
  onBack,
}: PitchDeckSourceInputProps) {
  const [sourceStep, setSourceStep] = useState<SourceStep>('picker')
  const [urlValue, setUrlValue] = useState('')
  const [emailValue, setEmailValue] = useState('')
  const [passwordValue, setPasswordValue] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const urlInputRef = useRef<HTMLInputElement>(null)

  const detectedPlatform = urlValue ? detectDeckPlatform(urlValue) : null

  async function handlePickPdf() {
    const filePath = await api.invoke<string | null>(IPC_CHANNELS.COMPANY_PITCH_DECK_OPEN_DIALOG)
    if (!filePath) return
    onIngestStart()
    try {
      const raw = await api.invoke<PitchDeckIngestResult>(IPC_CHANNELS.COMPANY_PITCH_DECK_INGEST, {
        source: { type: 'pdf', path: filePath },
        companyId,
      })
      if ('error' in raw) {
        onError(raw.error)
      } else {
        onResult(raw.result)
      }
    } catch {
      onError('An unexpected error occurred — please try again')
    }
  }

  async function handleIngestUrl() {
    const trimmedUrl = urlValue.trim()
    if (!trimmedUrl) return
    onIngestStart()
    try {
      const raw = await api.invoke<PitchDeckIngestResult>(IPC_CHANNELS.COMPANY_PITCH_DECK_INGEST, {
        source: {
          type: 'url',
          url: trimmedUrl,
          email: emailValue.trim() || undefined,
          password: passwordValue.trim() || undefined,
        },
        companyId,
      })
      if ('error' in raw) {
        onError(raw.error)
      } else {
        onResult(raw.result)
      }
    } catch {
      onError('An unexpected error occurred — please try again')
    }
  }

  if (sourceStep === 'url-input') {
    return (
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
            autoFocus
          />
        </div>
        {(detectedPlatform?.requiresEmail || emailValue) && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Email (for gated access)</label>
            <input
              className={styles.input}
              type="email"
              placeholder="you@fund.com"
              value={emailValue}
              onChange={(e) => setEmailValue(e.target.value)}
            />
            <p className={styles.emailHint}>
              Some platforms require an email to access the deck. Use the address the deck was shared with.
            </p>
          </div>
        )}
        {emailValue && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Password (if required)</label>
            <input
              className={styles.input}
              type={showPassword ? 'text' : 'password'}
              placeholder="optional"
              value={passwordValue}
              onChange={(e) => setPasswordValue(e.target.value)}
            />
            <button
              className={styles.passwordToggle}
              onClick={() => setShowPassword((v) => !v)}
              type="button"
            >
              {showPassword ? 'Hide password' : 'Show password'}
            </button>
          </div>
        )}
        <div className={styles.footer}>
          <button className={styles.backBtn} onClick={() => setSourceStep('picker')}>← Back</button>
          <button
            className={styles.primaryBtn}
            onClick={() => void handleIngestUrl()}
            disabled={!urlValue.trim()}
          >
            Extract
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.sourcePicker}>
      <p className={styles.sourcePickerLabel}>Choose a source to extract company data from</p>
      <div className={styles.sourceOptions}>
        <button className={styles.sourceOption} onClick={() => void handlePickPdf()}>
          <span className={styles.sourceOptionIcon}>📄</span>
          <span className={styles.sourceOptionText}>
            <span className={styles.sourceOptionTitle}>Pitch deck PDF</span>
            <span className={styles.sourceOptionDesc}>Choose a PDF — AI extracts updates automatically</span>
          </span>
        </button>
        <button
          className={styles.sourceOption}
          onClick={() => {
            setSourceStep('url-input')
            setTimeout(() => urlInputRef.current?.focus(), 50)
          }}
        >
          <span className={styles.sourceOptionIcon}>🔗</span>
          <span className={styles.sourceOptionText}>
            <span className={styles.sourceOptionTitle}>Website or link</span>
            <span className={styles.sourceOptionDesc}>DocSend, company website, Notion, etc.</span>
          </span>
        </button>
      </div>
      {onBack && (
        <div className={styles.footer}>
          <button className={styles.backBtn} onClick={onBack}>← Back</button>
        </div>
      )}
    </div>
  )
}
