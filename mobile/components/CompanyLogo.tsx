import { useEffect, useState } from 'react'
import { Image, StyleSheet, View, type ViewStyle } from 'react-native'
import { Avatar } from './Avatar'
import { colors, radii } from '../theme'

// Logo lookup stages. We try services in this order and downgrade on
// failure — mirrors what desktop does (see
// src/renderer/routes/SearchResults.tsx). Exported so unit tests can lock
// the stage-machine without rendering RN.
export type LogoStage = 'clearbit' | 'favicon' | 'avatar'

export interface LogoResolution {
  /** What to render right now: a remote image, or the initials avatar. */
  kind: 'image' | 'avatar'
  /** Image source URL (only set when kind === 'image'). */
  uri?: string
  /** Initials to show (only set when kind === 'avatar'). */
  initials?: string
}

/**
 * Resolve the current stage to a renderable. Pure helper, unit-testable.
 *
 * Desktop pattern: Clearbit first, Google s2 favicon as fallback, then
 * nothing. Mobile replaces the "nothing" tail with a crimson initials
 * chip because list rows benefit from a visual anchor even when no logo
 * exists.
 *
 * Why s2 in the chain: Clearbit 404s for companies it has no record of
 * (e.g. early-stage startups), but Google's favicon service almost
 * always returns *something* — a real favicon if the site has one, or
 * the generic globe glyph otherwise. The globe glyph is the same
 * tradeoff the desktop accepts.
 */
export function resolveLogo(
  domain: string | null | undefined,
  name: string,
  stage: LogoStage,
): LogoResolution {
  if (!domain || stage === 'avatar') {
    return { kind: 'avatar', initials: initialsForCompany(name) }
  }
  const encoded = encodeURIComponent(domain)
  if (stage === 'clearbit') {
    return { kind: 'image', uri: `https://logo.clearbit.com/${encoded}` }
  }
  // favicon
  return {
    kind: 'image',
    // sz=128 — RN image cache stores at requested size, so we ask for one
    // size suitable for the hero (72px) and rounded rows (28px both look
    // crisp downscaled from 128).
    uri: `https://www.google.com/s2/favicons?sz=128&domain=${encoded}`,
  }
}

/**
 * Next stage to advance to when the current source errors. avatar is the
 * terminal state — once there, we don't move (the Avatar can't error).
 */
export function nextStage(stage: LogoStage): LogoStage {
  if (stage === 'clearbit') return 'favicon'
  return 'avatar'
}

// Legacy 3-arg shape kept so existing call sites and unit tests continue
// to work. New code should prefer `resolveLogo` directly.
export type LogoState =
  | { kind: 'avatar'; initials: string }
  | { kind: 'image'; uri: string }

export function computeLogoState(
  domain: string | null | undefined,
  name: string,
  hasError: boolean,
): LogoState {
  const resolution = resolveLogo(domain, name, hasError ? 'avatar' : 'clearbit')
  if (resolution.kind === 'avatar') {
    return { kind: 'avatar', initials: resolution.initials ?? initialsForCompany(name) }
  }
  return { kind: 'image', uri: resolution.uri! }
}

// Derive a usable Clearbit / favicon lookup domain from either primaryDomain
// (already bare) or a websiteUrl ("https://www.acme.com/about" → "acme.com").
// Returns null when neither is usable. Callers pass the result as `domain` to
// <CompanyLogo /> so companies enriched with only a website URL still get a
// real logo instead of the initials fallback.
export function deriveLogoDomain(
  primaryDomain: string | null | undefined,
  websiteUrl: string | null | undefined,
): string | null {
  const direct = primaryDomain?.trim()
  if (direct) return direct.replace(/^www\./i, '')
  const site = websiteUrl?.trim()
  if (!site) return null
  try {
    const url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`)
    const host = url.hostname.replace(/^www\./i, '')
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

export function initialsForCompany(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  const words = trimmed.split(/\s+/).slice(0, 2)
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

// CompanyLogo — renders the company's logo via a Clearbit → Google favicon
// → initials chain, mirroring the desktop fallback. The state machine:
//
//   stage = 'clearbit'
//     │
//     ▼
//   <Image src="logo.clearbit.com/<domain>" />
//     │       ─ onError ─►  stage = 'favicon'
//     │
//     ▼
//   <Image src="google.com/s2/favicons?domain=<domain>" />
//     │       ─ onError ─►  stage = 'avatar'
//     │
//     ▼
//   <Avatar initials=… crimson />  (terminal — no further fallback)
//
// We don't use Clearbit-only anymore because it 404s for early-stage
// companies where the user (and Google) DO know the domain. The favicon
// fallback gives us at least a real per-site icon (or Google's globe
// glyph) before we land on initials.

export interface CompanyLogoProps {
  /** Domain for the company (e.g. "acme.com"). Falsy → initials. */
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
  // Start at clearbit unless there's no domain at all (then jump straight
  // to the initials avatar). Reset whenever the target domain changes so
  // a row recycled in a FlatList doesn't carry over a previous error.
  const [stage, setStage] = useState<LogoStage>(domain ? 'clearbit' : 'avatar')
  useEffect(() => {
    setStage(domain ? 'clearbit' : 'avatar')
  }, [domain])

  const borderRadius = shape === 'pill' ? radii.pill : Math.max(4, Math.round(size * 0.18))
  const resolution = resolveLogo(domain, name, stage)

  if (resolution.kind === 'avatar') {
    const avatarStyle: ViewStyle = {
      ...(shape === 'pill' ? null : { borderRadius }),
      ...style,
    }
    // Crimson identity for the initials fallback so a company without a
    // resolvable logo still reads as "company" (not the slate Avatar used
    // for user/contact chips).
    return (
      <Avatar
        initials={resolution.initials ?? '?'}
        size={size}
        color={colors.crimson}
        style={avatarStyle}
      />
    )
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
        source={{ uri: resolution.uri! }}
        style={{ width: size, height: size, borderRadius }}
        resizeMode="contain"
        onError={() => setStage((s) => nextStage(s))}
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
