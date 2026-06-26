// Cyggie brand voice — public API.
//
// USAGE RULES (read before importing):
//   • In React render (JSX): use `useVoiceLine` from
//     '@renderer/hooks/useVoice' — it picks once per mount and reads the
//     user's intensity setting. Do NOT call `voice()` / `pickRandom` in render;
//     they re-roll every render and make copy flicker.
//   • In event handlers (toasts, sync results computed once): `voice()` is fine.
//   • Non-React surfaces / tests: `voiceFor()` for deterministic output.
//
// The voice never touches the "straight path": destructive confirmations,
// failures that carry a count/outcome, and security/auth errors stay plain.

import { voiceCatalog } from './catalog'
import { pickRandom, pickSeeded, resolve } from './pick'
import type { Intensity, Slot, SubKey, Surface, Variant } from './types'

export type { Intensity, Slot, SubKey, Surface, Variant, VoiceCatalog } from './types'
export { voiceCatalog, lateNightLoading } from './catalog'
export { pickSeeded, pickRandom, resolve } from './pick'

const GENERIC: Slot = { plain: 'Nothing here yet.', subtle: [], full: [] }

/** Look up a slot, falling back to the surface's `generic` then a safe default. */
export function resolveSlot(surface: Surface, sub: SubKey): Slot {
  return voiceCatalog[surface][sub] ?? voiceCatalog[surface].generic ?? GENERIC
}

export interface VoiceOptions {
  seed?: string | number
  variant?: Variant
  intensity?: Intensity
}

/** Deterministic line — same seed always returns the same line. */
export function voiceFor(surface: Surface, sub: SubKey, opts: VoiceOptions = {}): string {
  const { seed = `${surface}:${sub}`, variant = 'empty', intensity = 'full' } = opts
  const pool = resolve(resolveSlot(surface, sub), intensity, variant)
  return pickSeeded(pool, seed)
}

/** Fresh random line — event handlers only (never in render). */
export function voice(surface: Surface, sub: SubKey, opts: Omit<VoiceOptions, 'seed'> = {}): string {
  const { variant = 'empty', intensity = 'full' } = opts
  return pickRandom(resolve(resolveSlot(surface, sub), intensity, variant))
}

/** True during the late-night window (22:00–04:59) for the loading wink. */
export function isLateNight(hour: number): boolean {
  return hour >= 22 || hour < 5
}
