/**
 * Reading-appearance preferences — the single source of truth for how
 * long-form text (TipTap editors + the meeting-summary `.markdown` view) is
 * rendered: line spacing, font size, and line length (measure).
 *
 * Three consumers share this module so they can never drift:
 *   - Settings → Appearance tab (AppearanceSection.tsx) — canonical UI
 *   - TiptapBubbleMenu "Aa Display" popover — in-context shortcut
 *   - useAppearance() hook + main.tsx pre-paint — applies tokens to :root
 *
 * Data flow:
 *   cyggie:appearance (preferences.store, synced)  ─┐
 *                                                    ├─▶ validate() ─▶ applyAppearance()
 *   localStorage mirror (pre-paint, no FOUC)        ─┘        │
 *                                                             ▼
 *               document.documentElement.style --cy-reading-{lh,gap,fs,mw}
 *               which inherit into every .tiptapContent surface + .markdown
 *
 * Every value is validated/clamped: a corrupt or unknown stored preference
 * degrades silently to DEFAULTS rather than throwing or rendering broken CSS.
 */

export type LineSpacing = 'compact' | 'normal' | 'relaxed'
export type FontSize = 's' | 'm' | 'l'
export type LineWidth = 'narrow' | 'normal' | 'wide'

export interface AppearancePrefs {
  lineSpacing: LineSpacing
  fontSize: FontSize
  lineWidth: LineWidth
}

/** Shipped baseline — matches the historical hardcoded look (line-height 1.6,
 *  0.75em paragraph gap, 1em font, full-width). Used as the fallback for any
 *  missing/invalid field and by the (future) "reset to defaults" affordance. */
export const DEFAULTS: AppearancePrefs = {
  lineSpacing: 'normal',
  fontSize: 'm',
  lineWidth: 'normal',
}

/** The preference key in preferences.store (synced) and the localStorage mirror.
 *  Follows the existing `cyggie:` namespace convention. */
export const APPEARANCE_PREF_KEY = 'cyggie:appearance'

/** CSS custom properties set on :root. Defined with defaults in globals.css so
 *  untouched users render correctly even before JS runs. */
interface ReadingTokens {
  '--cy-reading-lh': string // line-height (unitless)
  '--cy-reading-gap': string // paragraph bottom margin
  '--cy-reading-fs': string // font-size of reading surfaces
  '--cy-reading-mw': string // max-width (measure) of reading surfaces
}

const LINE_SPACING_TOKENS: Record<LineSpacing, Pick<ReadingTokens, '--cy-reading-lh' | '--cy-reading-gap'>> = {
  compact: { '--cy-reading-lh': '1.4', '--cy-reading-gap': '0.35em' },
  normal: { '--cy-reading-lh': '1.6', '--cy-reading-gap': '0.75em' },
  relaxed: { '--cy-reading-lh': '1.9', '--cy-reading-gap': '1.15em' },
}

const FONT_SIZE_TOKENS: Record<FontSize, Pick<ReadingTokens, '--cy-reading-fs'>> = {
  s: { '--cy-reading-fs': '0.9em' },
  m: { '--cy-reading-fs': '1em' },
  l: { '--cy-reading-fs': '1.15em' },
}

// 'normal' caps at 72rem (~1152px) — wider than every editor surface at typical
// window sizes, so it preserves today's full-width look in practice while still
// reining in ultra-wide monitors. 'wide' is truly uncapped. Capped content is
// centered via margin-inline:auto (see tiptap.module.css).
const LINE_WIDTH_TOKENS: Record<LineWidth, Pick<ReadingTokens, '--cy-reading-mw'>> = {
  narrow: { '--cy-reading-mw': '46rem' },
  normal: { '--cy-reading-mw': '72rem' },
  wide: { '--cy-reading-mw': '100%' },
}

/** Human-readable labels for the three controls (Settings + Aa popover). */
export const LINE_SPACING_OPTIONS: ReadonlyArray<{ value: LineSpacing; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'relaxed', label: 'Relaxed' },
]

export const FONT_SIZE_OPTIONS: ReadonlyArray<{ value: FontSize; label: string }> = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' },
]

export const LINE_WIDTH_OPTIONS: ReadonlyArray<{ value: LineWidth; label: string }> = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
]

function isOneOf<T extends string>(value: unknown, allowed: Record<T, unknown>): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(allowed, value)
}

/**
 * Coerce an arbitrary stored value into a complete, valid AppearancePrefs.
 * Any missing/unknown field falls back to DEFAULTS — never throws.
 */
export function validate(raw: unknown): AppearancePrefs {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppearancePrefs, unknown>>
  return {
    lineSpacing: isOneOf<LineSpacing>(obj.lineSpacing, LINE_SPACING_TOKENS) ? obj.lineSpacing : DEFAULTS.lineSpacing,
    fontSize: isOneOf<FontSize>(obj.fontSize, FONT_SIZE_TOKENS) ? obj.fontSize : DEFAULTS.fontSize,
    lineWidth: isOneOf<LineWidth>(obj.lineWidth, LINE_WIDTH_TOKENS) ? obj.lineWidth : DEFAULTS.lineWidth,
  }
}

/** Resolve a validated prefs object into the four CSS custom-property values. */
export function tokensFor(prefs: AppearancePrefs): ReadingTokens {
  return {
    ...LINE_SPACING_TOKENS[prefs.lineSpacing],
    ...FONT_SIZE_TOKENS[prefs.fontSize],
    ...LINE_WIDTH_TOKENS[prefs.lineWidth],
  }
}

/**
 * Apply appearance tokens to the document root. Accepts raw (unvalidated) input
 * so callers — including the synchronous pre-paint path in main.tsx — can pass
 * straight from storage without their own validation. No-ops outside the DOM.
 */
export function applyAppearance(raw: unknown, target?: HTMLElement): void {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (!root) return
  const tokens = tokensFor(validate(raw))
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value)
  }
}
