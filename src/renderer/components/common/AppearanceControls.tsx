/**
 * Presentational segmented controls for reading appearance (line spacing, text
 * size, line width). Pure: takes the current prefs + an onChange, no store
 * access — so it can be reused in both the Settings → Appearance tab (light)
 * and the TiptapBubbleMenu "Aa" popover (dark) without duplicating the option
 * lists or the layout. Option lists come from lib/appearance.ts.
 */
import {
  FONT_SIZE_OPTIONS,
  LINE_SPACING_OPTIONS,
  LINE_WIDTH_OPTIONS,
  type AppearancePrefs,
} from '../../lib/appearance'
import styles from './AppearanceControls.module.css'

interface AppearanceControlsProps {
  value: AppearancePrefs
  onChange: (next: AppearancePrefs) => void
  /** 'light' for Settings, 'dark' for the bubble popover. Default 'light'. */
  tone?: 'light' | 'dark'
}

export function AppearanceControls({ value, onChange, tone = 'light' }: AppearanceControlsProps) {
  return (
    <div className={`${styles.root} ${tone === 'dark' ? styles.dark : styles.light}`}>
      <Row
        label="Line spacing"
        options={LINE_SPACING_OPTIONS}
        selected={value.lineSpacing}
        onSelect={(v) => onChange({ ...value, lineSpacing: v })}
      />
      <Row
        label="Text size"
        options={FONT_SIZE_OPTIONS}
        selected={value.fontSize}
        onSelect={(v) => onChange({ ...value, fontSize: v })}
      />
      <Row
        label="Line width"
        options={LINE_WIDTH_OPTIONS}
        selected={value.lineWidth}
        onSelect={(v) => onChange({ ...value, lineWidth: v })}
      />
    </div>
  )
}

interface RowProps<T extends string> {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  selected: T
  onSelect: (value: T) => void
}

function Row<T extends string>({ label, options, selected, onSelect }: RowProps<T>) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.segmented} role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={opt.value === selected ? styles.segActive : styles.seg}
            aria-pressed={opt.value === selected}
            onClick={() => onSelect(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
