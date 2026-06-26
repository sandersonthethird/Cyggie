// @vitest-environment jsdom

import { describe, expect, test, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceLine } from '../useVoice'
import { usePreferencesStore } from '../../stores/preferences.store'

function setIntensity(value: 'off' | 'subtle' | 'full' | undefined) {
  // Drive the store directly (no window.api persistence in jsdom).
  usePreferencesStore.setState({
    prefs: value === undefined ? {} : { brandVoiceIntensity: JSON.stringify(value) },
  })
}

afterEach(() => setIntensity(undefined))

describe('useVoiceLine', () => {
  test('stays fixed across many re-renders (anti-flicker)', () => {
    setIntensity('full')
    const { result, rerender } = renderHook(() => useVoiceLine('emptyState', 'contacts'))
    const first = result.current
    expect(first.length).toBeGreaterThan(0)
    for (let i = 0; i < 50; i++) rerender()
    expect(result.current).toBe(first)
  })

  test('off intensity yields the plain line', () => {
    setIntensity('off')
    const { result } = renderHook(() => useVoiceLine('emptyState', 'contacts'))
    expect(result.current).toBe('No contacts found.')
  })

  test('re-picks when the intensity setting changes', () => {
    setIntensity('off')
    const { result, rerender } = renderHook(() => useVoiceLine('emptyState', 'contacts'))
    expect(result.current).toBe('No contacts found.')
    act(() => setIntensity('full'))
    rerender()
    // Full tier should differ from the plain off line.
    expect(result.current).not.toBe('No contacts found.')
  })

  test('defaults to full voice when no preference is set', () => {
    setIntensity(undefined)
    const { result } = renderHook(() => useVoiceLine('emptyState', 'companies'))
    expect(result.current.length).toBeGreaterThan(0)
  })
})
