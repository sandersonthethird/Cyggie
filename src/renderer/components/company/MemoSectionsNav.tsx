/**
 * Section-aware nav rendered above the memo editor when a producer-agent
 * memo is displayed.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Parses `## ` headings out of the memo markdown and renders     │
 *   │  one row per section with:                                      │
 *   │                                                                 │
 *   │    • a per-section "Refresh" button (Delight #5) — invokes      │
 *   │      INVESTMENT_MEMO_REGENERATE_SECTION                         │
 *   │    • a source-count chip showing how many memo_evidence rows   │
 *   │      were attributed to that section                            │
 *   │    • on hover/focus, a popover listing those evidence rows     │
 *   │      grouped by source_type (Delight #1)                       │
 *   │                                                                 │
 *   │  Lives ABOVE the TipTap editor (not inside it) so we don't      │
 *   │  fight with TipTap's node model or extension API.               │
 *   │                                                                 │
 *   │  Legacy rows (section === null, pre-migration 090) are dropped │
 *   │  from `evidenceBySection` — the count chip shows 0 and the     │
 *   │  hover popover is suppressed for those sections.                │
 *   └────────────────────────────────────────────────────────────────┘
 */

import { useMemo, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import type { InvestmentMemoVersion, MemoGenerateMeta } from '../../../shared/types/company'
import type { StoredMemoEvidence } from '../../../shared/types/memo-evidence'
import { Tooltip } from '../common/Tooltip'
import styles from './MemoSectionsNav.module.css'

interface MemoSectionsNavProps {
  companyId: string
  /** Memo markdown currently displayed. Parsed for `## ` headings. */
  markdown: string
  /** Evidence rows for this memo version; passed from CompanyMemo via useMemoEvidence. */
  evidence: readonly StoredMemoEvidence[]
  /** Whether a generation/refresh is currently in flight (disables buttons). */
  busy: boolean
  /** Called when a section refresh succeeds; passes the new version + meta. */
  onSectionRefreshed: (version: InvestmentMemoVersion, meta?: MemoGenerateMeta) => void
  /** Called when a refresh fails; passes a human-readable error. */
  onError: (msg: string) => void
  /** Called when the user clicks an evidence row in the section popover. */
  onOpenSidebar?: (claimText: string) => void
  /** When true, render a leading "Reports" button that opens the latest stress-test report. */
  hasStressTestReport?: boolean
  /** Click handler for the "Reports" button. */
  onOpenLatestReport?: () => void
}

interface RefreshResponse {
  success: boolean
  contentMarkdown?: string
  version?: InvestmentMemoVersion
  meta?: MemoGenerateMeta
  error?: string
  errorCode?: string
  aborted?: boolean
}

function parseSectionHeadings(markdown: string): string[] {
  const out: string[] = []
  for (const line of markdown.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * Group evidence rows by their section. Rows with section === null are dropped
 * (legacy memos pre-migration 090). Exported for unit testing.
 */
export function groupEvidenceBySection(
  evidence: readonly StoredMemoEvidence[],
): Map<string, StoredMemoEvidence[]> {
  const map = new Map<string, StoredMemoEvidence[]>()
  for (const row of evidence) {
    if (!row.section) continue
    const list = map.get(row.section) ?? []
    list.push(row)
    map.set(row.section, list)
  }
  return map
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  meeting: 'Meetings',
  note: 'Notes',
  email: 'Emails',
  drive_file: 'Files',
  web: 'Web',
  contact: 'Contacts',
}

const SOURCE_TYPE_ORDER = ['web', 'meeting', 'note', 'drive_file', 'contact', 'email']

export function MemoSectionsNav({
  companyId,
  markdown,
  evidence,
  busy,
  onSectionRefreshed,
  onError,
  onOpenSidebar,
  hasStressTestReport,
  onOpenLatestReport,
}: MemoSectionsNavProps) {
  const headings = useMemo(() => parseSectionHeadings(markdown), [markdown])
  const evidenceBySection = useMemo(() => groupEvidenceBySection(evidence), [evidence])
  const [refreshingHeading, setRefreshingHeading] = useState<string | null>(null)

  if (headings.length === 0) return null

  async function refresh(heading: string) {
    if (busy || refreshingHeading) return
    setRefreshingHeading(heading)
    try {
      const result = await api.invoke<RefreshResponse>(
        IPC_CHANNELS.INVESTMENT_MEMO_REGENERATE_SECTION,
        { companyId, sectionHeading: heading },
      )
      if (result.aborted) return
      if (!result.success || !result.version) {
        onError(result.error || `Failed to refresh "${heading}"`)
        return
      }
      onSectionRefreshed(result.version, result.meta)
    } catch (e) {
      onError(e instanceof Error ? e.message : `Failed to refresh "${heading}"`)
    } finally {
      setRefreshingHeading(null)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.label}>Sections</div>
      {hasStressTestReport && onOpenLatestReport && (
        <button
          type="button"
          className={styles.reportsBtn}
          onClick={onOpenLatestReport}
          title="Open latest stress-test report"
          aria-label="Open latest stress-test report"
        >
          📋 Reports
        </button>
      )}
      <ul className={styles.list}>
        {headings.map((h) => {
          const isThis = refreshingHeading === h
          const disabled = busy || refreshingHeading !== null
          const sectionEvidence = evidenceBySection.get(h) ?? []
          const sectionRow = (
            <li key={h} className={styles.row}>
              <a className={styles.headingLink} href={`#${headingToAnchor(h)}`}>
                {h}
              </a>
              {sectionEvidence.length > 0 && (
                <span className={styles.countChip} aria-label={`${sectionEvidence.length} sources`}>
                  {sectionEvidence.length}
                </span>
              )}
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={() => refresh(h)}
                disabled={disabled}
                title={`Regenerate "${h}" against current data`}
                aria-label={`Refresh section: ${h}`}
              >
                {isThis ? '…' : '↻'}
              </button>
            </li>
          )

          // Only wrap rows with attributed evidence in a Tooltip — suppresses
          // empty popovers for legacy memos (per eng-review legacy-rows = Omit).
          if (sectionEvidence.length === 0) return sectionRow
          return (
            <Tooltip
              key={h}
              side="bottom"
              delay={200}
              content={<SectionSourcesPopover heading={h} rows={sectionEvidence} onOpenSidebar={onOpenSidebar} />}
            >
              {sectionRow}
            </Tooltip>
          )
        })}
      </ul>
    </div>
  )
}

function headingToAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Inline popover content for the section hover (Delight #1).
 *
 * Groups the section's evidence rows by source_type so the user can scan at
 * a glance: "this section is backed by 3 web sources + 2 meeting refs".
 * Each row clicks through to open the EvidenceSidebar focused on that claim.
 *
 * Inlined into MemoSectionsNav rather than extracted to a separate file per
 * the eng-review minimal-diff preference.
 */
function SectionSourcesPopover({
  heading,
  rows,
  onOpenSidebar,
}: {
  heading: string
  rows: readonly StoredMemoEvidence[]
  onOpenSidebar?: (claimText: string) => void
}) {
  const groups = useMemo(() => {
    const byType = new Map<string, StoredMemoEvidence[]>()
    for (const row of rows) {
      const list = byType.get(row.sourceType) ?? []
      list.push(row)
      byType.set(row.sourceType, list)
    }
    // Sort groups by SOURCE_TYPE_ORDER then by remaining alphabetical.
    return Array.from(byType.entries()).sort(([a], [b]) => {
      const ia = SOURCE_TYPE_ORDER.indexOf(a)
      const ib = SOURCE_TYPE_ORDER.indexOf(b)
      const ra = ia === -1 ? SOURCE_TYPE_ORDER.length : ia
      const rb = ib === -1 ? SOURCE_TYPE_ORDER.length : ib
      return ra - rb || a.localeCompare(b)
    })
  }, [rows])

  return (
    <div className={styles.popover}>
      <div className={styles.popoverHeader}>
        <span className={styles.popoverTitle}>Sources for {heading}</span>
        <span className={styles.popoverCount}>{rows.length}</span>
      </div>
      {groups.map(([sourceType, sourceRows]) => (
        <div key={sourceType} className={styles.popoverGroup}>
          <div className={styles.popoverGroupLabel}>
            {SOURCE_TYPE_LABELS[sourceType] ?? sourceType} ({sourceRows.length})
          </div>
          <ul className={styles.popoverRows}>
            {sourceRows.map((row) => (
              <li key={row.id} className={styles.popoverRow}>
                <button
                  type="button"
                  className={styles.popoverRowBtn}
                  onClick={() => onOpenSidebar?.(row.claimText)}
                  title="Open in evidence sidebar"
                >
                  <span className={styles.popoverClaim}>{truncate(row.claimText, 80)}</span>
                  <span className={styles.popoverSnippet}>{truncate(row.snippet, 60)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max).trimEnd() + '…'
}
