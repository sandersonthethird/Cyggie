// @vitest-environment jsdom
/**
 * Tests for useFindInPage's active-match scroll behavior — specifically the
 * `scrollRoot` branch added so the memo edit modal can recenter its own match
 * without grabbing a background surface's stale `mark.markActive`.
 *
 *   scrollRoot set   → query WITHIN scrollRoot, scrollIntoView({ block: 'center' })
 *   scrollRoot unset → document-wide query,     scrollIntoView({ block: 'nearest' })
 *
 * DOM setup (both tests):
 *   <div #outside>  <mark.markActive> </div>   ← appended FIRST → first in doc order
 *   <div #inside>   <mark.markActive> </div>   ← passed as scrollRoot
 *
 * scrollIntoView doesn't exist in jsdom, so we stub it on Element.prototype and
 * record the element it was called on (`this`) plus the options.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { useFindInPage } = await import('../renderer/hooks/useFindInPage')

interface ScrollCall {
  el: Element
  opts: ScrollIntoViewOptions | undefined
}

let scrollCalls: ScrollCall[]
let outsideMark: HTMLElement
let insideContainer: HTMLElement
let insideMark: HTMLElement
let originalScrollIntoView: typeof Element.prototype.scrollIntoView

function makeMark(): HTMLElement {
  const mark = document.createElement('mark')
  mark.className = 'markActive'
  mark.textContent = 'a'
  return mark
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollCalls = []
  originalScrollIntoView = Element.prototype.scrollIntoView
  // jsdom doesn't implement scrollIntoView — stub it and capture this/opts.
  Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions | boolean) {
    scrollCalls.push({ el: this, opts: typeof opts === 'object' ? opts : undefined })
  }

  // Background surface's mark — appended first so it's first in document order.
  const outsideContainer = document.createElement('div')
  outsideContainer.id = 'outside'
  outsideMark = makeMark()
  outsideContainer.appendChild(outsideMark)
  document.body.appendChild(outsideContainer)

  // Scoped surface (e.g. the modal editor's view.dom).
  insideContainer = document.createElement('div')
  insideContainer.id = 'inside'
  insideMark = makeMark()
  insideContainer.appendChild(insideMark)
  document.body.appendChild(insideContainer)
})

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function advancePastDebounceAndScroll() {
  // 150ms query debounce → matches computed → scroll effect schedules a 10ms timer.
  act(() => { vi.advanceTimersByTime(150) })
  act(() => { vi.advanceTimersByTime(10) })
}

describe('useFindInPage scroll-into-view', () => {
  it('with scrollRoot: scopes the query to scrollRoot and centers the match', () => {
    const { result } = renderHook(() =>
      useFindInPage({
        text: 'aaa',
        isOpen: true,
        onOpen: vi.fn(),
        onClose: vi.fn(),
        scrollRoot: insideContainer,
      }),
    )

    act(() => { result.current.setQuery('a') })
    advancePastDebounceAndScroll()

    expect(scrollCalls).toHaveLength(1)
    expect(scrollCalls[0].el).toBe(insideMark)
    expect(scrollCalls[0].opts?.block).toBe('center')
  })

  it('without scrollRoot: queries document-wide and uses nearest', () => {
    const { result } = renderHook(() =>
      useFindInPage({
        text: 'aaa',
        isOpen: true,
        onOpen: vi.fn(),
        onClose: vi.fn(),
      }),
    )

    act(() => { result.current.setQuery('a') })
    advancePastDebounceAndScroll()

    expect(scrollCalls).toHaveLength(1)
    // First mark.markActive in document order is the background/outside one.
    expect(scrollCalls[0].el).toBe(outsideMark)
    expect(scrollCalls[0].opts?.block).toBe('nearest')
  })
})
