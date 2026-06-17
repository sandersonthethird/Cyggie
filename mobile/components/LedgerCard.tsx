import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, type } from '../theme'

// Unified Ledger — one calm card whose rows are bucketed into ordered groups
// under quiet uppercase sub-labels separated by hairlines, with loud,
// right-aligned tabular values. Shared by the Company and Contact detail
// Overview segments. Each screen buckets its already-filtered fields into
// groups; this component only renders.

export type PillTone = 'violet' | 'green' | 'sky' | 'neutral'

export type PillSpec = { label: string; tone?: PillTone; dot?: boolean }

export type LedgerRow = {
  key: string
  /** Plain text value (right-aligned, tabular). */
  value?: string | null
  /** When set, render these pills on the value side instead of text. */
  pills?: PillSpec[]
  /** Render the value as a sky-blue link (no underline). */
  link?: boolean
}

export type LedgerGroup = { label: string; rows: LedgerRow[] }

// Pill background tints not covered by an existing theme token.
const PILL_VIOLET_BG = '#F5F3FF'
const PILL_GREEN_BG = '#ECFDF5'

const PILL_TONES: Record<PillTone, { bg: string; fg: string }> = {
  violet: { bg: PILL_VIOLET_BG, fg: colors.chipViolet },
  green: { bg: PILL_GREEN_BG, fg: colors.success },
  sky: { bg: colors.chipSkyMuted, fg: colors.chipSky },
  neutral: { bg: colors.surface3, fg: colors.text2 },
}

export function Pill({ label, tone = 'neutral', dot = false }: PillSpec) {
  const { bg, fg } = PILL_TONES[tone]
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {dot && <View style={[styles.pillDot, { backgroundColor: fg }]} />}
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  )
}

export function LedgerCard({ groups }: { groups: LedgerGroup[] }) {
  const visible = groups.filter((g) => g.rows.length > 0)
  if (visible.length === 0) return null

  return (
    <View style={styles.card}>
      {visible.map((group, gIdx) => (
        <View
          key={group.label}
          style={gIdx > 0 ? styles.groupDivided : undefined}
        >
          <Text style={styles.groupLabel}>{group.label}</Text>
          {group.rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <Text style={styles.rowKey}>{row.key}</Text>
              {row.pills ? (
                <View style={styles.rowPills}>
                  {row.pills.map((p, i) => (
                    <Pill key={`${p.label}-${i}`} {...p} />
                  ))}
                </View>
              ) : (
                <Text
                  style={row.link ? styles.rowLink : styles.rowValue}
                  numberOfLines={2}
                >
                  {row.value}
                </Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

/** `https://www.linkedin.com/company/initlabs/` -> `/company/initlabs` */
export function linkedinPath(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    return path || u.hostname.replace(/^www\./i, '')
  } catch {
    return url
      .replace(/^https?:\/\//i, '')
      .replace(/^www\.linkedin\.com/i, '')
      .replace(/\/$/, '')
  }
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 4,
  },
  groupLabel: {
    fontSize: type.caption,
    fontWeight: '700',
    color: colors.text4,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.md,
    paddingTop: 13,
    paddingBottom: 5,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  rowKey: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '500',
    flexShrink: 0,
  },
  rowValue: {
    color: colors.text,
    fontSize: type.bodyTight,
    fontWeight: '600',
    textAlign: 'right',
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  rowLink: {
    color: colors.chipSky,
    fontSize: type.bodyTight,
    fontWeight: '500',
    textAlign: 'right',
    flexShrink: 1,
  },
  rowPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 5,
    flexShrink: 1,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 1.5,
    paddingHorizontal: 8,
    borderRadius: radii.pill,
  },
  pillDot: {
    width: 5,
    height: 5,
    borderRadius: 99,
  },
  pillText: {
    fontSize: type.meta,
    fontWeight: '500',
  },
})
