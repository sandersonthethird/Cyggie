// React bindings for the Cyggie brand voice.
//
// `useVoiceLine` is the default for anything rendered in JSX: it picks one line
// once per mount (via useRef, Strict-Mode safe) and reads the user's intensity
// setting reactively. It deliberately does NOT call Math.random() during render
// — that would re-roll the copy on every keystroke/scroll and flicker.
//
// For event-handler copy (toasts), use `useVoiceFn` to get a function bound to
// the current intensity, then call it inside the handler.

import { useCallback, useMemo, useRef } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import {
  voiceFor,
  voice,
  isLateNight,
  lateNightLoading,
  pickRandom,
  type Intensity,
  type SubKey,
  type Surface,
  type Variant,
  type VoiceOptions,
} from '@shared/voice'

export const BRAND_VOICE_PREF_KEY = 'brandVoiceIntensity'
const DEFAULT_INTENSITY: Intensity = 'full'

/** Reactively read the user's brand-voice intensity setting. */
export function useBrandVoiceIntensity(): Intensity {
  const raw = usePreferencesStore((s) => s.prefs[BRAND_VOICE_PREF_KEY])
  return useMemo(() => {
    if (raw == null) return DEFAULT_INTENSITY
    try {
      const parsed = JSON.parse(raw)
      return parsed === 'off' || parsed === 'subtle' || parsed === 'full' ? parsed : DEFAULT_INTENSITY
    } catch {
      return DEFAULT_INTENSITY
    }
  }, [raw])
}

// Module-scoped counter gives variety across mounts without Math.random in
// render. Each mount claims one stable seed for its lifetime.
let mountSeed = 0

/**
 * One brand-voice line, fixed for the lifetime of this component instance and
 * re-picked only when the intensity setting or variant changes.
 */
export function useVoiceLine(surface: Surface, sub: SubKey, variant: Variant = 'empty'): string {
  const intensity = useBrandVoiceIntensity()
  const seedRef = useRef<number | undefined>(undefined)
  if (seedRef.current === undefined) seedRef.current = mountSeed++
  return useMemo(
    () => voiceFor(surface, sub, { seed: `${surface}:${sub}:${seedRef.current}`, variant, intensity }),
    [surface, sub, variant, intensity],
  )
}

/**
 * A loading line that respects the time of day — late at night it draws from a
 * separate wink pool. Picks once per mount.
 */
export function useLoadingLine(sub: SubKey = 'generic', hour?: number): string {
  const intensity = useBrandVoiceIntensity()
  const seedRef = useRef<number | undefined>(undefined)
  if (seedRef.current === undefined) seedRef.current = mountSeed++
  return useMemo(() => {
    if (intensity !== 'off' && hour !== undefined && isLateNight(hour)) {
      return pickRandom(lateNightLoading)
    }
    return voiceFor('loading', sub, { seed: `loading:${sub}:${seedRef.current}`, variant: 'empty', intensity })
  }, [sub, hour, intensity])
}

/**
 * Returns a function that yields a FRESH random line on each call, bound to the
 * current intensity. Use in event handlers (toasts, sync results) — never in
 * render.
 */
export function useVoiceFn(): (surface: Surface, sub: SubKey, opts?: Omit<VoiceOptions, 'seed' | 'intensity'>) => string {
  const intensity = useBrandVoiceIntensity()
  return useCallback(
    (surface, sub, opts = {}) => voice(surface, sub, { ...opts, intensity }),
    [intensity],
  )
}
