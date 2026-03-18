import { createPortal } from 'react-dom'
import styles from './EnrichmentProposalDialog.module.css'

export interface EnrichmentFieldChange {
  /** Unique key for this field across all entities — format: `${entityId}:${fieldName}` */
  key: string
  label: string
  from: string | null
  to: string | null
}

export interface EnrichmentEntityProposal {
  entityId: string
  entityName: string
  changes: EnrichmentFieldChange[]
}

export interface EnrichmentProposalDialogProps {
  open: boolean
  title: string
  subtitle: string
  proposals: EnrichmentEntityProposal[]
  /** Keys are `${entityId}:${fieldName}`. Missing key or `true` = selected; `false` = deselected. */
  fieldSelections: Record<string, boolean>
  onFieldToggle: (key: string, value: boolean) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onApply: () => void
  onSkip: () => void
  isApplying: boolean
}

export function EnrichmentProposalDialog({
  open,
  title,
  subtitle,
  proposals,
  fieldSelections,
  onFieldToggle,
  onSelectAll,
  onDeselectAll,
  onApply,
  onSkip,
  isApplying,
}: EnrichmentProposalDialogProps) {
  if (!open) return null
  const allKeys = proposals.flatMap(p => p.changes.map(c => c.key))
  const selectedCount = allKeys.filter(k => fieldSelections[k] !== false).length
  const allDeselected = selectedCount === 0

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.subtitle}>{subtitle}</p>

        <div className={styles.selectionToolbar}>
          <button className={styles.selectionBtn} onClick={onSelectAll} disabled={isApplying}>
            Select all
          </button>
          <button className={styles.selectionBtn} onClick={onDeselectAll} disabled={isApplying}>
            Deselect all
          </button>
        </div>

        <div className={styles.proposalList}>
          {proposals.map((proposal) => (
            <div key={proposal.entityId} className={styles.entityGroup}>
              <div className={styles.entityName}>{proposal.entityName}</div>
              {proposal.changes.map((change) => (
                <div key={change.key} className={styles.fieldRow}>
                  <input
                    type="checkbox"
                    className={styles.fieldCheckbox}
                    checked={fieldSelections[change.key] !== false}
                    onChange={(e) => onFieldToggle(change.key, e.target.checked)}
                    disabled={isApplying}
                  />
                  <span className={styles.fieldLabel}>{change.label}:</span>
                  {change.from != null && (
                    <>
                      <span className={styles.fieldFrom}>{change.from}</span>
                      <span className={styles.fieldArrow}>→</span>
                    </>
                  )}
                  {change.from == null && (
                    <>
                      <span className={styles.fieldFrom}>(empty)</span>
                      <span className={styles.fieldArrow}>→</span>
                    </>
                  )}
                  <span className={styles.fieldTo}>{change.to}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className={styles.actions}>
          <button className={styles.skipBtn} onClick={onSkip} disabled={isApplying}>
            Skip
          </button>
          <button
            className={styles.applyBtn}
            onClick={onApply}
            disabled={isApplying || allDeselected}
          >
            {isApplying
              ? 'Applying…'
              : `Apply ${selectedCount} update${selectedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
