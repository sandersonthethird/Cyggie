import { ConfidenceChip } from './ConfidenceChip'
import { useMemoEvidence } from '../../hooks/useMemoEvidence'
import styles from './EvidenceSidebar.module.css'

/**
 * Evidence sidebar — opens when the user hovers a claim or right-clicks and
 * picks "What's the evidence for this?". Shows the matching evidence rows
 * from `memo_evidence` for the active version, grouped into supporting
 * evidence vs. critique counter-evidence.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Lookup: rows for the (versionId, claimText) pair are fetched   │
 *   │  via IPC (MEMO_EVIDENCE_LIST_BY_VERSION returns ALL rows for    │
 *   │  the version; we client-side filter to the active claim).       │
 *   │                                                                 │
 *   │  Phase 1 uses fuzzy substring matching on claim_text. Phase 2   │
 *   │  will swap to stable claim_id (per-claim re-verification).      │
 *   └────────────────────────────────────────────────────────────────┘
 */

import type { StoredMemoEvidence } from '../../../shared/types/memo-evidence'

export interface EvidenceSidebarProps {
  versionId: string | null
  /** The selected/hovered claim text. Empty means closed. */
  activeClaim: string
  onClose: () => void
}

export function EvidenceSidebar({ versionId, activeClaim, onClose }: EvidenceSidebarProps) {
  const { evidence: allEvidence, loaded } = useMemoEvidence(versionId)
  const loading = !loaded

  // Filter to the active claim. Use loose substring matching in either
  // direction so minor edits between the rendered memo and the persisted
  // claim text don't break the lookup.
  const matched = activeClaim
    ? allEvidence.filter(e => substringMatch(e.claimText, activeClaim))
    : []
  const supporting = matched.filter(e => !e.isCritique)
  const critiques = matched.filter(e => e.isCritique)

  if (!activeClaim) return null

  return (
    <aside className={styles.sidebar} role="complementary" aria-label="Evidence for selected claim">
      <header className={styles.header}>
        <h3 className={styles.title}>Evidence</h3>
        <button className={styles.close} onClick={onClose} aria-label="Close evidence">×</button>
      </header>
      <div className={styles.claim}>
        <span className={styles.claimLabel}>Selected claim</span>
        <p className={styles.claimText}>{activeClaim}</p>
      </div>

      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : matched.length === 0 ? (
        <p className={styles.empty}>No evidence rows attached to this claim.</p>
      ) : (
        <>
          {supporting.length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionHeader}>Supporting ({supporting.length})</h4>
              {supporting.map(ev => <EvidenceCard key={ev.id} evidence={ev} />)}
            </section>
          )}
          {critiques.length > 0 && (
            <section className={styles.section}>
              <h4 className={`${styles.sectionHeader} ${styles.critique}`}>Counter-evidence ({critiques.length})</h4>
              {critiques.map(ev => <EvidenceCard key={ev.id} evidence={ev} />)}
            </section>
          )}
        </>
      )}
    </aside>
  )
}

function EvidenceCard({ evidence }: { evidence: StoredMemoEvidence }) {
  const link = evidence.sourceUrl
  return (
    <article className={`${styles.card} ${evidence.isCritique ? styles.cardCritique : ''}`}>
      <header className={styles.cardHeader}>
        <span className={styles.sourceType}>{evidence.sourceType}</span>
        <ConfidenceChip confidence={evidence.confidence} label />
        {evidence.severity ? <span className={`${styles.severity} ${styles[`severity-${evidence.severity}`]}`}>{evidence.severity}</span> : null}
      </header>
      <blockquote className={styles.snippet}>{evidence.snippet}</blockquote>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className={styles.link}>
          {hostnameOrPath(link)}
        </a>
      ) : evidence.sourceId ? (
        <span className={styles.sourceRef}>id: {evidence.sourceId.slice(0, 12)}…</span>
      ) : null}
    </article>
  )
}

function hostnameOrPath(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 30) + (u.pathname.length > 30 ? '…' : '') : '')
  } catch {
    return url.slice(0, 50)
  }
}

function substringMatch(a: string, b: string): boolean {
  const aClean = a.trim().toLowerCase()
  const bClean = b.trim().toLowerCase()
  if (!aClean || !bClean) return false
  return aClean.includes(bClean) || bClean.includes(aClean)
}
