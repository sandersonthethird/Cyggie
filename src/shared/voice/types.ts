// Cyggie brand voice — type contracts for the copy catalog.
//
// The voice is bold & irreverent (see catalog.ts) but reversible: every slot
// carries a `plain` line (the original, neutral copy) so the `off` intensity
// and the "straight path" always have something safe to render.

/** Where a line is shown. Drives which sub-keys are valid. */
export type Surface =
  | 'emptyState'
  | 'loading'
  | 'toast'
  | 'error'
  | 'onboarding'
  | 'milestone'

/** The specific thing within a surface (entity type, step, event…). */
export type SubKey =
  // emptyState / loading / generic
  | 'contacts'
  | 'companies'
  | 'notes'
  | 'deals'
  | 'meetings'
  | 'timeline'
  | 'decisions'
  | 'memo'
  | 'chats'
  | 'generic'
  | 'integrations'
  // toast
  | 'syncUpToDate'
  // error
  | 'chatStart'
  // milestone
  | 'firstContact'
  | 'firstCompany'
  | 'meetingCentury'
  // onboarding steps
  | 'signIn'
  | 'workspace'
  | 'storage'
  | 'google'
  | 'keys'
  | 'team'
  | 'done'

/**
 * Empty-state context: did the user land here because there's no data yet
 * (`empty`), or because their search/filter matched nothing (`filtered`)?
 * Only `emptyState` slots vary on this; everything else ignores it.
 */
export type Variant = 'empty' | 'filtered'

/** User-controlled humor level. `off` always yields the plain line. */
export type Intensity = 'off' | 'subtle' | 'full'

/**
 * One copy slot. `plain` is the single neutral fallback (also the `off`
 * output and the straight-path copy). `subtle` / `full` are rotation pools;
 * an empty pool degrades to the next tier down (full → subtle → plain).
 *
 * For empty-state slots that distinguish search-misses, provide `filtered`
 * overrides; when absent the base tiers are used for both variants.
 */
export interface Slot {
  plain: string
  subtle: readonly string[]
  full: readonly string[]
  /** Optional per-variant override pools for the `filtered` context. */
  filtered?: {
    plain?: string
    subtle?: readonly string[]
    full?: readonly string[]
  }
}

/** Catalog is partial — not every surface defines every sub-key. */
export type VoiceCatalog = {
  [S in Surface]: Partial<Record<SubKey, Slot>>
}
