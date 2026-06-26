// =============================================================================
// Step 4 (Import) — bring in existing contacts/companies from a CSV, and learn
// the firm's field model. Reuses the production ImportModal for the
// file → map → preview → import flow; on success we accumulate the mappings,
// derive the firm field profile (which fields the firm provided data for), let
// the user toggle any off, and persist it to the synced `user_preferences` key
// `onboarding:firm-field-profile`. That profile later steers targeted enrichment
// (see getFirmFieldProfile in the main process). Skippable. Supports importing
// more than one file (e.g. contacts.csv then companies.csv).
// =============================================================================

import { useMemo, useState } from 'react'
import { usePreferencesStore } from '../../../stores/preferences.store'
import { ImportModal } from '../../settings/ImportModal'
import { deriveFieldProfile, type FirmFieldProfile } from '../onboarding-logic'
import { StepLinks } from '../StepLinks'
import styles from '../Onboarding.module.css'
import type { FieldMapping, ImportResult } from '../../../../shared/types/csv-import'

const PROFILE_PREF_KEY = 'onboarding:firm-field-profile'

/** Field key → readable label for the review toggles. */
function prettify(key: string): string {
  if (key.startsWith('custom:')) return 'Custom field'
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function ImportStep({
  onImported,
  onBack,
  onContinue,
}: {
  onImported: () => void
  onBack: () => void
  onContinue: () => void
}) {
  const setJSON = usePreferencesStore((s) => s.setJSON)
  const [modalOpen, setModalOpen] = useState(false)
  const [mappingsPerFile, setMappingsPerFile] = useState<FieldMapping[][]>([])
  const [totals, setTotals] = useState({ contacts: 0, companies: 0, updated: 0, files: 0 })
  // Tokens (`contact:<key>` / `company:<key>`) the user turned OFF in the review.
  const [dropped, setDropped] = useState<Set<string>>(new Set())

  const hasImported = mappingsPerFile.length > 0
  const base = useMemo(() => deriveFieldProfile(mappingsPerFile), [mappingsPerFile])

  const handleComplete = ({ mappings, result }: { mappings: FieldMapping[]; result: ImportResult }) => {
    setMappingsPerFile((prev) => [...prev, mappings])
    setTotals((t) => ({
      contacts: t.contacts + result.contactsCreated,
      companies: t.companies + result.companiesCreated,
      updated: t.updated + result.contactsUpdated,
      files: t.files + 1,
    }))
    setModalOpen(false)
    // Mark the step done now so a reload resumes AFTER the import, never back inside
    // a side-effecting wizard.
    onImported()
  }

  const toggle = (token: string) =>
    setDropped((prev) => {
      const next = new Set(prev)
      if (next.has(token)) next.delete(token)
      else next.add(token)
      return next
    })

  const persistAndContinue = () => {
    const profile: FirmFieldProfile = {
      version: 1,
      source: 'onboarding-csv',
      contact: base.contact.filter((k) => !dropped.has(`contact:${k}`)),
      company: base.company.filter((k) => !dropped.has(`company:${k}`)),
      updatedAt: new Date().toISOString(),
    }
    // setJSON catches its own async persist errors (non-fatal): the import already
    // succeeded, so a failed profile write never blocks finishing onboarding.
    setJSON(PROFILE_PREF_KEY, profile)
    onContinue()
  }

  if (modalOpen) {
    return <ImportModal onClose={() => setModalOpen(false)} onComplete={handleComplete} />
  }

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Import your contacts &amp; companies</h1>
        <p className={styles.sub}>
          Bring in a CSV from your old CRM or a spreadsheet to catch anyone calendar and
          email won&rsquo;t. Cyggie learns which fields you track and keeps them enriched.
        </p>
      </div>

      {!hasImported ? (
        <>
          <button type="button" className={styles.primaryBtn} onClick={() => setModalOpen(true)}>
            Import a CSV file
          </button>
          <StepLinks onBack={onBack} onSkip={onContinue} />
        </>
      ) : (
        <>
          <p className={styles.pendingNote}>
            ✓ Imported {totals.contacts} contacts, {totals.companies} companies
            {totals.updated > 0 ? `, updated ${totals.updated}` : ''}
            {totals.files > 1 ? ` across ${totals.files} files` : ''}.
          </p>

          {(base.contact.length > 0 || base.company.length > 0) && (
            <div className={styles.stack}>
              <p className={styles.sub}>
                These are the fields we&rsquo;ll keep enriched. Turn off any you don&rsquo;t
                want Cyggie to maintain.
              </p>
              {base.contact.length > 0 && (
                <FieldToggleGroup title="Contacts" entity="contact" keys={base.contact} dropped={dropped} onToggle={toggle} />
              )}
              {base.company.length > 0 && (
                <FieldToggleGroup title="Companies" entity="company" keys={base.company} dropped={dropped} onToggle={toggle} />
              )}
            </div>
          )}

          <button type="button" className={styles.primaryBtn} onClick={persistAndContinue}>
            Continue
          </button>
          <StepLinks onBack={onBack} onSkip={() => setModalOpen(true)} skipLabel="Import another file" />
        </>
      )}
    </div>
  )
}

function FieldToggleGroup({
  title,
  entity,
  keys,
  dropped,
  onToggle,
}: {
  title: string
  entity: 'contact' | 'company'
  keys: string[]
  dropped: Set<string>
  onToggle: (token: string) => void
}) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{title}</span>
      <div className={styles.fieldToggleRow}>
        {keys.map((k) => {
          const token = `${entity}:${k}`
          return (
            <label key={token} className={styles.fieldToggle}>
              <input type="checkbox" checked={!dropped.has(token)} onChange={() => onToggle(token)} />
              {prettify(k)}
            </label>
          )
        })}
      </div>
    </div>
  )
}
