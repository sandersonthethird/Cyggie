// Deterministic + random line selection for the brand voice.
//
// IMPORTANT: `pickRandom` calls Math.random() and MUST NOT be used in a React
// render path — it re-rolls on every render and causes copy to flicker while
// typing/scrolling (the app just shipped a batch of "stop the flash" fixes;
// don't reopen that). Use `pickSeeded` (or the useVoiceLine hook) in JSX.

import type { Intensity, Slot, Variant } from './types'

/** FNV-1a 32-bit hash → stable index from a seed string. */
function hash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** Same seed → same line. Use anywhere copy is chosen during render. */
export function pickSeeded(lines: readonly string[], seed: string | number): string {
  if (lines.length === 0) return ''
  if (lines.length === 1) return lines[0]
  return lines[hash(String(seed)) % lines.length]
}

/** Fresh random line. Event handlers only (toasts), never in render. */
export function pickRandom(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return lines[Math.floor(Math.random() * lines.length)]
}

/**
 * Collapse a slot to the rotation pool for a given intensity + variant,
 * degrading full → subtle → plain so a thin tier never renders blank.
 * `off` always returns just the plain line.
 */
export function resolve(slot: Slot, intensity: Intensity, variant: Variant = 'empty'): readonly string[] {
  const override = variant === 'filtered' ? slot.filtered : undefined
  const plain = override?.plain ?? slot.plain

  if (intensity === 'off') return [plain]

  const full = override?.full ?? slot.full
  const subtle = override?.subtle ?? slot.subtle

  if (intensity === 'full') {
    if (full.length) return full
    if (subtle.length) return subtle
    return [plain]
  }

  // subtle
  if (subtle.length) return subtle
  return [plain]
}
