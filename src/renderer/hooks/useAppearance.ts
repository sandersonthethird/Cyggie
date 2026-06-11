/**
 * Applies the user's reading-appearance preference to the document root and
 * keeps the localStorage mirror fresh for the next launch's pre-paint apply
 * (see main.tsx) — which is what prevents a flash of default spacing (FOUC).
 *
 * The synced preferences.store is the source of truth. localStorage is only a
 * pre-paint cache: it's written here on every change and read once, early, in
 * main.tsx before React renders.
 *
 * Mount once near the app root (alongside <PreferencesInit/>). Returns nothing.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import { setJSON as mirrorSet } from '../lib/safe-storage'
import { APPEARANCE_PREF_KEY, DEFAULTS, applyAppearance, validate, type AppearancePrefs } from '../lib/appearance'

export function useAppearance(): void {
  // Subscribe to the raw stored string so this re-runs whenever the pref
  // changes (Settings tab or the bubble's Aa popover both write it).
  const raw = usePreferencesStore((s) => s.prefs[APPEARANCE_PREF_KEY])

  useEffect(() => {
    const prefs = raw == null ? DEFAULTS : validate(safeParse(raw))
    applyAppearance(prefs)
    // Mirror the validated value (not the raw string) so a corrupt store entry
    // never poisons the pre-paint cache.
    mirrorSet(APPEARANCE_PREF_KEY, prefs)
  }, [raw])
}

/**
 * Read/write the reading-appearance preference. Backed by the synced
 * preferences.store; writing triggers useAppearance() (mounted at the root) to
 * re-apply tokens app-wide. Shared by the Settings tab and the bubble's "Aa"
 * popover so the two controls can never diverge.
 */
export function useAppearancePref(): [AppearancePrefs, (next: AppearancePrefs) => void] {
  const raw = usePreferencesStore((s) => s.prefs[APPEARANCE_PREF_KEY])
  const setJSON = usePreferencesStore((s) => s.setJSON)
  const prefs = useMemo(() => (raw == null ? DEFAULTS : validate(safeParse(raw))), [raw])
  const setPrefs = useCallback((next: AppearancePrefs) => setJSON(APPEARANCE_PREF_KEY, next), [setJSON])
  return [prefs, setPrefs]
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
