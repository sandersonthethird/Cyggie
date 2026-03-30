// @vitest-environment jsdom
/**
 * Tests for useDigestItemAutoSave hook.
 *
 * State machine under test:
 *
 *   collapsed ──► expand ──► { expanded=true, hasEdited=false }
 *                                │
 *                       user types ──► markEdited() + setDraft(md)
 *                                │         └─► debouncedDraft changes
 *                                │               └─► auto-save fires
 *                                │
 *                       collapse ──► flushSave(md)
 *                                      ├─ hasEdited=true → onSave(md)
 *                                      └─ hasEdited=false → NO save (prevents wipe)
 *
 * Mock boundaries:
 *   - useDebounce → pass-through (synchronous; eliminates timing from assertions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../renderer/hooks/useDebounce', () => ({
  useDebounce: <T>(value: T) => value,
}))

const { useDigestItemAutoSave } = await import('../renderer/hooks/useDigestItemAutoSave')

describe('useDigestItemAutoSave', () => {
  let onSave: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSave = vi.fn()
  })

  // ── Auto-save effect ───────────────────────────────────────────────────────

  it('does NOT call onSave on initial expand (debouncedDraft unchanged from collapse)', () => {
    // Start collapsed — initial effect fires but guards on !expanded
    const { rerender } = renderHook(
      ({ expanded }) => useDigestItemAutoSave({ content: null, onSave, expanded }),
      { initialProps: { expanded: false } },
    )

    onSave.mockClear()

    // Expand: debouncedDraft is still '' — auto-save effect deps unchanged → no re-run
    rerender({ expanded: true })

    expect(onSave).not.toHaveBeenCalled()
  })

  it('calls onSave after typing while expanded (debouncedDraft changes)', () => {
    const { result, rerender } = renderHook(
      ({ expanded }) => useDigestItemAutoSave({ content: null, onSave, expanded }),
      { initialProps: { expanded: false } },
    )

    rerender({ expanded: true })
    onSave.mockClear()

    // Simulate typing: markEdited + setDraft → debouncedDraft changes → effect fires
    act(() => {
      result.current.markEdited()
      result.current.setDraft('typed content')
    })

    expect(onSave).toHaveBeenCalledWith('typed content')
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  // ── flushSave (collapse handler) ──────────────────────────────────────────

  it('flushSave does NOT call onSave when user has not edited (expand-then-close)', () => {
    const { result, rerender } = renderHook(
      ({ expanded }) => useDigestItemAutoSave({ content: 'existing brief', onSave, expanded }),
      { initialProps: { expanded: false } },
    )

    rerender({ expanded: true })
    onSave.mockClear()

    // Collapse without typing (no markEdited call)
    act(() => { result.current.flushSave('existing brief') })

    expect(onSave).not.toHaveBeenCalled()
  })

  it('flushSave calls onSave when user has edited', () => {
    const { result, rerender } = renderHook(
      ({ expanded }) => useDigestItemAutoSave({ content: null, onSave, expanded }),
      { initialProps: { expanded: false } },
    )

    rerender({ expanded: true })

    // Simulate typing: setDraft + markEdited, letting auto-save fire
    act(() => {
      result.current.setDraft('user typed this')
      result.current.markEdited()
    })
    onSave.mockClear()

    // flushSave with same content — debouncedDraft unchanged → only direct path fires
    act(() => { result.current.flushSave('user typed this') })

    expect(onSave).toHaveBeenCalledWith('user typed this')
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  // ── hasEdited resets on each expand ───────────────────────────────────────

  it('hasEdited resets to false on second expand (first expand had edits)', () => {
    // Use content='some text' so collapse resets draft to 'some text' (same value → no
    // debouncedDraft change), ensuring flushSave doesn't trigger the auto-save effect.
    const { result, rerender } = renderHook(
      ({ expanded }) => useDigestItemAutoSave({ content: 'some text', onSave, expanded }),
      { initialProps: { expanded: false } },
    )

    // First expand — mark edited (no content change needed; draft already 'some text')
    rerender({ expanded: true })
    act(() => { result.current.markEdited() })

    // Collapse — content-sync resets draft to 'some text' (same value → no state change)
    rerender({ expanded: false })

    // Second expand — hasEdited resets to false
    rerender({ expanded: true })
    onSave.mockClear()

    // flushSave with 'some text' — draft already 'some text' → setDraft bails out →
    // debouncedDraft unchanged → auto-save does not fire.
    // hasEdited=false → direct path also skipped → onSave not called.
    act(() => { result.current.flushSave('some text') })

    expect(onSave).not.toHaveBeenCalled()
  })

  // ── Content sync from parent ───────────────────────────────────────────────

  it('syncs draft from parent content prop when collapsed', () => {
    const { result, rerender } = renderHook(
      ({ content }) => useDigestItemAutoSave({ content, onSave, expanded: false }),
      { initialProps: { content: 'old content' as string | null } },
    )

    expect(result.current.draft).toBe('old content')

    rerender({ content: 'new content from db' })

    expect(result.current.draft).toBe('new content from db')
  })

  it('does NOT sync draft from parent content prop when expanded (preserves in-progress edits)', () => {
    const { result, rerender } = renderHook(
      ({ content, expanded }) => useDigestItemAutoSave({ content, onSave, expanded }),
      { initialProps: { content: 'original' as string | null, expanded: false } },
    )

    // Expand and type
    rerender({ content: 'original', expanded: true })
    act(() => { result.current.setDraft('in-progress edit') })

    // Parent content changes while expanded (background enrichment) — draft should stay
    rerender({ content: 'background update', expanded: true })

    expect(result.current.draft).toBe('in-progress edit')
  })
})
