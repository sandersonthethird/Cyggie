import { useEffect, useState } from 'react'
import { Image, StyleSheet, View, type ViewStyle } from 'react-native'
import { Avatar } from './Avatar'
import { colors, radii } from '../theme'

// Pure helper extracted so it can be unit-tested without rendering RN. The
// component does no other branching beyond what this returns. Exported for
// tests; production callers should use <CompanyLogo /> below.
export type LogoState =
  | { kind: 'avatar'; initials: string }
  | { kind: 'image'; uri: string }

export function computeLogoState(
  domain: string | null | undefined,
  name: string,
  hasError: boolean,
): LogoState {
  if (!domain || hasError) {
    return { kind: 'avatar', initials: initialsForCompany(name) }
  }
  return {
    kind: 'image',
    uri: `https://logo.clearbit.com/${encodeURIComponent(domain)}`,
  }
}

export function initialsForCompany(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  const words = trimmed.split(/\s+/).slice(0, 2)
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

// CompanyLogo — renders the company's Clearbit logo, falling back to the
// initials Avatar when the domain is missing or Clearbit returns an error.
//
// State machine:
//
//   props.domain
//        │
//   ┌────┴────┐
//   ▼         ▼
//  null/    string
//  empty       │
//   │          ▼
//   │       <Image src="logo.clearbit.com/<domain>" />
//   │          │
//   │       onError? ──no──► (image rendered)
//   │          │yes
//   │          ▼
//   └───────► <Avatar initials={initials(name)} />
//
// We intentionally use Clearbit at every size — desktop uses Google s2 for
// small favicons, but s2 returns HTTP 200 + a generic globe icon for unknown
// domains, which means onError never fires and the row shows a globe instead
// of falling back to initials. Clearbit 404s on unknown domains, giving us a
// clean error signal we can swap on.

export interface CompanyLogoProps {
  /** Primary domain for the company (e.g. "acme.com"). Falsy → initials. */
  domain: string | null | undefined
  /** Used for the initials fallback. */
  name: string
  /** Pixel size. Default 40. */
  size?: number
  /** Shape of the badge. `pill` = circular (hero), `rounded` = squircle (rows). */
  shape?: 'pill' | 'rounded'
  style?: ViewStyle
}

export function CompanyLogo({
  domain,
  name,
  size = 40,
  shape = 'rounded',
  style,
}: CompanyLogoProps) {
  const [hasError, setHasError] = useState(false)

  // Reset error state when the target domain changes (e.g. row recycled in a
  // FlatList) so a previously-failed row doesn't permanently show initials
  // when the underlying company changes.
  useEffect(() => {
    setHasError(false)
  }, [domain])

  const borderRadius = shape === 'pill' ? radii.pill : Math.max(4, Math.round(size * 0.18))
  const state = computeLogoState(domain, name, hasError)

  if (state.kind === 'avatar') {
    const avatarStyle: ViewStyle = {
      ...(shape === 'pill' ? null : { borderRadius }),
      ...style,
    }
    return <Avatar initials={state.initials} size={size} style={avatarStyle} />
  }

  return (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: colors.surface3,
        },
        style,
      ]}
    >
      <Image
        source={{ uri: state.uri }}
        style={{ width: size, height: size, borderRadius }}
        resizeMode="contain"
        onError={() => setHasError(true)}
        accessibilityIgnoresInvertColors
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
})
