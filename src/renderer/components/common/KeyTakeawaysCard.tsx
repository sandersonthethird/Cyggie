import { useMemo } from 'react'
import type { TakeawaysState } from './KeyTakeawaysCard.types'
import type { UserNoteState } from '../../hooks/useUserNote'
import styles from './KeyTakeawaysCard.module.css'

// Re-export the state type so consumers only need one import
export type { TakeawaysState }

interface KeyTakeawaysCardProps {
  kt: TakeawaysState
  /** User-authored note region pinned to the top of the card.
   *  When undefined, the card renders AI takeaways only (back-compat for
   *  any consumer that hasn't wired up useUserNote yet). */
  userNote?: UserNoteState
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
const USER_NOTE_PLACEHOLDER = '+ Add note…'

function splitBullets(text: string): string[] {
  if (!text) return []
  return text
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean)
}

/**
 * Key Takeaways card. Renders a single visual list of bullets, with the user's
 * own note pinned at the top followed by AI-generated bullets. Click any bullet
 * to edit that region inline — user-note bullets edit the user note; AI bullets
 * edit the AI text. The header keeps only the ✨ Generate/Update + collapse
 * controls.
 *
 *   ┌─── card ─────────────────────────────────────────────────────────┐
 *   │  ✦ KEY TAKEAWAYS                       [✨ Update / Generate] [▼]│
 *   │                                                                  │
 *   │  • user note line 1     ← click to edit user note               │
 *   │  • user note line 2                                              │
 *   │  • AI bullet 1          ← click to edit AI text                  │
 *   │  • AI bullet 2                                                   │
 *   └──────────────────────────────────────────────────────────────────┘
 */
export function KeyTakeawaysCard({
  kt,
  userNote,
  footerText,
  collapsed,
  onToggleCollapsed,
  emptyStateText,
}: KeyTakeawaysCardProps) {
  const aiBullets = useMemo(() => splitBullets(kt.text), [kt.text])
  const userBullets = useMemo(
    () => (userNote ? splitBullets(userNote.userNote) : []),
    [userNote?.userNote],
  )

  const isCollapsed = collapsed === true
  const collapsible = onToggleCollapsed !== undefined

  // Header actions hidden when collapsed (body is hidden anyway).
  const showActionBtn = !isCollapsed && (kt.showGenerate || kt.showUpdate)
  const showGeneratingLabel = !isCollapsed && kt.generating

  // The bottom-of-card "click ✨ Generate…" placeholder only shows when there's
  // nothing at all — no AI bullets AND (no user note section OR the user note
  // is empty). When the user note region exists with content, that's already
  // enough signal not to feel empty.
  const aiRegionEmpty =
    !kt.text && !kt.generating && !kt.editing
  const showEmptyHint =
    aiRegionEmpty && (!userNote || (!userNote.userNote && !userNote.editing))

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
          {/* User-note region. Independent of AI edit state. */}
          {userNote && (
            userNote.editing ? (
              <>
                <textarea
                  ref={userNote.textareaRef}
                  className={styles.editArea}
                  defaultValue={userNote.userNote}
                  autoFocus
                  maxLength={2000}
                  placeholder="Your note — appears at the top of Key Takeaways. Each new line becomes a bullet."
                  onKeyDown={(e) => { if (e.key === 'Escape') userNote.cancelEditing() }}
                />
                <div className={styles.editActions}>
                  <button className={styles.cancelBtn} onClick={userNote.cancelEditing}>Cancel</button>
                  <button className={styles.saveBtn} onClick={userNote.save}>Save</button>
                </div>
                {userNote.error && <div className={styles.error}>{userNote.error}</div>}
              </>
            ) : userBullets.length > 0 ? (
              <ul className={styles.bullets}>
                {userBullets.map((bullet, i) => (
                  <li
                    key={`u-${i}`}
                    className={`${styles.bullet} ${styles.bulletClickable}`}
                    onClick={userNote.startEditing}
                    title="Click to edit your note"
                  >
                    <span className={styles.bulletDot} />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className={styles.bullets}>
                <li
                  className={`${styles.bullet} ${styles.bulletClickable} ${styles.userNoteEmpty}`}
                  onClick={userNote.startEditing}
                  title="Add your own note to the top of Key Takeaways"
                >
                  <span className={styles.bulletDot} />
                  <span>{USER_NOTE_PLACEHOLDER}</span>
                </li>
              </ul>
            )
          )}

          {/* AI region. Independent of user-note edit state. */}
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
              {aiBullets.map((bullet, i) => (
                <li
                  key={`ai-${i}`}
                  className={`${styles.bullet} ${styles.bulletClickable}`}
                  onClick={kt.startEditing}
                  title="Click to edit AI takeaways"
                >
                  <span className={styles.bulletDot} />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          ) : showEmptyHint ? (
            <div className={styles.emptyState}>{emptyStateText ?? DEFAULT_EMPTY_TEXT}</div>
          ) : null}

          {kt.error && <div className={styles.error}>{kt.error}</div>}
          {footerText && <div className={styles.footer}>{footerText}</div>}
        </>
      )}
    </div>
  )
}
