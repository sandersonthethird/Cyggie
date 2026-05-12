/**
 * Section-aware nav rendered above the memo editor when a producer-agent
 * memo is displayed.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Parses `## ` headings out of the memo markdown and renders     │
 *   │  one row per section with a per-section "Refresh" button       │
 *   │  (Delight #5). Clicking Refresh invokes                         │
 *   │  INVESTMENT_MEMO_REGENERATE_SECTION, which re-runs the producer │
 *   │  agent for that single section against current data; a new      │
 *   │  memo version is persisted with a `Refreshed section: X` note. │
 *   │                                                                 │
 *   │  Lives ABOVE the TipTap editor (not inside it) so we don't      │
 *   │  fight with TipTap's node model or extension API. Position is   │
 *   │  visually adjacent enough that the section/refresh association │
 *   │  is clear.                                                      │
 *   └────────────────────────────────────────────────────────────────┘
 */

import { useMemo, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import type { InvestmentMemoVersion, MemoGenerateMeta } from '../../../shared/types/company'
import styles from './MemoSectionsNav.module.css'

interface MemoSectionsNavProps {
  companyId: string
  /** Memo markdown currently displayed. Parsed for `## ` headings. */
  markdown: string
  /** Whether a generation/refresh is currently in flight (disables buttons). */
  busy: boolean
  /** Called when a section refresh succeeds; passes the new version + meta. */
  onSectionRefreshed: (version: InvestmentMemoVersion, meta?: MemoGenerateMeta) => void
  /** Called when a refresh fails; passes a human-readable error. */
  onError: (msg: string) => void
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

export function MemoSectionsNav({
  companyId,
  markdown,
  busy,
  onSectionRefreshed,
  onError,
}: MemoSectionsNavProps) {
  const headings = useMemo(() => parseSectionHeadings(markdown), [markdown])
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
      <ul className={styles.list}>
        {headings.map((h) => {
          const isThis = refreshingHeading === h
          const disabled = busy || refreshingHeading !== null
          return (
            <li key={h} className={styles.row}>
              <a className={styles.headingLink} href={`#${headingToAnchor(h)}`}>
                {h}
              </a>
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
