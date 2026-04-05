/**
 * SmartFilters — quick-filter preset pills for the table toolbar.
 *
 * Active detection uses presence-only check (not value matching) so that
 * date-based presets don't become inactive the day after they were applied.
 *
 * Usage:
 *   <SmartFilters presets={COMPANY_PRESETS} searchParams={searchParams} onApply={...} />
 */
import styles from './SmartFilters.module.css'

export interface FilterPreset {
  id: string
  label: string
  /** Called lazily on click to get the params to merge into the URL. */
  getParams: () => Record<string, string>
  /** Keys to check for active detection and to clear on toggle-off. */
  paramKeys: string[]
}

interface SmartFiltersProps {
  presets: FilterPreset[]
  searchParams: URLSearchParams
  onApply: (params: Record<string, string>) => void
  onClear: (keys: string[]) => void
}

/** Presence-only active check — avoids date drift on time-based presets. */
export function isPresetActive(preset: FilterPreset, params: URLSearchParams): boolean {
  return preset.paramKeys.every((k) => params.has(k))
}

export function SmartFilters({ presets, searchParams, onApply, onClear }: SmartFiltersProps) {
  if (presets.length === 0) return null

  return (
    <div className={styles.row}>
      {presets.map((preset) => {
        const active = isPresetActive(preset, searchParams)
        return (
          <button
            key={preset.id}
            className={`${styles.pill} ${active ? styles.pillActive : ''}`}
            onClick={() => {
              if (active) {
                onClear(preset.paramKeys)
              } else {
                onApply(preset.getParams())
              }
            }}
          >
            {preset.label}
          </button>
        )
      })}
    </div>
  )
}
