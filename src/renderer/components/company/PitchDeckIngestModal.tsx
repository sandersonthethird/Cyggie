/**
 * PitchDeckIngestModal — lightweight source-picker + ingest flow for enriching
 * an existing company. Unlike NewCompanyModal (which has a review form + creation
 * step), this component calls back immediately with the raw extraction result so
 * CompanyDetail can feed it into EnrichmentProposalDialog.
 *
 * Steps: source-picker → url-input | loading → (onResult callback) | error
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PitchDeckExtractionResult } from '../../../shared/types/pitch-deck'
import { PitchDeckSourceInput } from './PitchDeckSourceInput'
import styles from './NewCompanyModal.module.css'

type Step = 'source' | 'loading' | 'error'

interface PitchDeckIngestModalProps {
  open: boolean
  companyId: string
  onResult: (result: PitchDeckExtractionResult) => void
  onClose: () => void
}

export default function PitchDeckIngestModal({
  open,
  companyId,
  onResult,
  onClose,
}: PitchDeckIngestModalProps) {
  const [step, setStep] = useState<Step>('source')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  function reset() {
    setStep('source')
    setErrorMsg(null)
  }

  if (!open) return null

  return createPortal(
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>
            {step === 'source'  && 'Enrich from Pitch Deck'}
            {step === 'loading' && 'Extracting…'}
            {step === 'error'   && 'Extraction Failed'}
          </h3>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Source picker */}
        {step === 'source' && (
          <PitchDeckSourceInput
            companyId={companyId}
            onIngestStart={() => setStep('loading')}
            onResult={(result) => {
              onResult(result)
              onClose()
              reset()
            }}
            onError={(msg) => {
              setErrorMsg(msg)
              setStep('error')
            }}
          />
        )}

        {/* Loading */}
        {step === 'loading' && (
          <div className={styles.loadingStep}>
            <div className={styles.spinner} />
            <p className={styles.loadingText}>Extracting company data…</p>
          </div>
        )}

        {/* Error */}
        {step === 'error' && (
          <>
            <div className={styles.errorStep}>
              <span className={styles.errorIcon}>⚠️</span>
              <p className={styles.errorText}>{errorMsg}</p>
            </div>
            <div className={styles.footer}>
              <button className={styles.secondaryBtn} onClick={() => { reset(); onClose() }}>Cancel</button>
              <button className={styles.primaryBtn} onClick={reset}>Try Again</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
