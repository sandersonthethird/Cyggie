import { useMemo } from 'react'
import type { TakeawaysState } from './KeyTakeawaysCard.types'
import styles from './KeyTakeawaysCard.module.css'

// Re-export the state type so consumers only need one import
export type { TakeawaysState }

interface KeyTakeawaysCardProps {
  kt: TakeawaysState
  /** Optional footer text (e.g. "Generated 2h ago from 4 meetings + 18 emails") */
  footerText?: string
  /** Optional controlled collapse state. If undefined, the card is always expanded
   *  and the collapse toggle is not rendered. */
  collapsed?: boolean
  /** Called when the user clicks the header label or the ▼/▶ toggle.
   *  Required if `collapsed` is provided. */
  onToggleCollapsed?: () => void
  /** Empty-state message shown inside the card when no takeaways exist. */
  emptyStateText?: string
}

const DEFAULT_EMPTY_TEXT = 'Click ✨ Generate to create AI-powered insights'

/**
 * AI-generated Key Takeaways card with brand-red accent.
 *
 *   ┌─── card shell (always rendered) ──────────────────────────────────┐
 *   │  ✦ KEY TAKEAWAYS         [Edit] [✨ Update / ✨ Generate]   [▼/▶]│
 *   │                                                                  │
 *   │  body (hidden when collapsed):                                   │
 *   │    bullets / streaming / edit textarea / empty-state / error     │
 *   │    + optional footer                                             │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Presentational component — all state comes from the `useTakeaways` hook.
 * Both ContactPropertiesPanel and CompanyPropertiesPanel render this component.
 */
export function KeyTakeawaysCard({
  kt,
  footerText,
  collapsed,
  onToggleCollapsed,
  emptyStateText,
}: KeyTakeawaysCardProps) {
  const bullets = useMemo(() => {
    if (!kt.text) return []
    return kt.text
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean)
  }, [kt.text])

  const isCollapsed = collapsed === true
  const collapsible = onToggleCollapsed !== undefined

  // Header actions hidden when collapsed (body is hidden anyway).
  const showEditBtn = !isCollapsed && !!kt.text && !kt.editing && !kt.generating
  const showActionBtn = !isCollapsed && (kt.showGenerate || kt.showUpdate)
  const showGeneratingLabel = !isCollapsed && kt.generating

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span
          className={styles.label}
          onClick={collapsible ? onToggleCollapsed : undefined}
          style={collapsible ? { cursor: 'pointer' } : undefined}
        >
          ✦ KEY TAKEAWAYS
        </span>
        <div className={styles.headerActions}>
          {showEditBtn && (
            <button className={styles.editBtn} onClick={kt.startEditing}>Edit</button>
          )}
          {showActionBtn && (
            <button className={styles.updateBtn} onClick={kt.generate}>
              {kt.hasNewData && <span className={styles.staleDot} />}
              ✨ {kt.text ? 'Update' : 'Generate'}
            </button>
          )}
          {showGeneratingLabel && (
            <span className={styles.editBtn} style={{ opacity: 0.6 }}>Generating…</span>
          )}
          {collapsible && (
            <button
              className={styles.editBtn}
              onClick={onToggleCollapsed}
              title={isCollapsed ? 'Expand' : 'Collapse'}
              aria-label={isCollapsed ? 'Expand Key Takeaways' : 'Collapse Key Takeaways'}
            >
              {isCollapsed ? '▶' : '▼'}
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <>
          {kt.editing ? (
            <>
              <textarea
                ref={kt.textareaRef}
                className={styles.editArea}
                defaultValue={kt.text}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Escape') kt.cancelEditing() }}
              />
              <div className={styles.editActions}>
                <button className={styles.cancelBtn} onClick={kt.cancelEditing}>Cancel</button>
                <button className={styles.saveBtn} onClick={kt.save}>Save</button>
              </div>
            </>
          ) : kt.generating && kt.streaming ? (
            <div className={styles.streamingText}>{kt.streaming}</div>
          ) : kt.generating ? (
            <div className={styles.streamingText}>Generating…</div>
          ) : kt.text ? (
            <ul className={styles.bullets}>
              {bullets.map((bullet, i) => (
                <li key={i} className={styles.bullet}>
                  <span className={styles.bulletDot} />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.emptyState}>{emptyStateText ?? DEFAULT_EMPTY_TEXT}</div>
          )}

          {kt.error && <div className={styles.error}>{kt.error}</div>}
          {footerText && <div className={styles.footer}>{footerText}</div>}
        </>
      )}
    </div>
  )
}
