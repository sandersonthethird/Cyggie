// @vitest-environment jsdom

import { describe, expect, test, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  PipelineStepper,
  COMPANY_PIPELINE_STAGES_FULL,
} from '../PipelineStepper'

afterEach(() => {
  cleanup()
})

// CSS-module class names are hashed at build (e.g. `_dot_abc123`), so we
// match on substring rather than exact name. The component sets `title`
// on each dot to its stage label — that's our stable selector.

const STAGE_LABELS = ['Sourced', 'Screening', 'Diligence', 'Partner', 'Term Sheet', 'Portfolio', 'Pass']

function getDots(container: HTMLElement): HTMLElement[] {
  return STAGE_LABELS.map((label) => {
    const dot = container.querySelector(`[title="${label}"]`)
    if (!dot) throw new Error(`dot for "${label}" not found`)
    return dot as HTMLElement
  })
}

function hasClassContaining(el: HTMLElement, substr: string): boolean {
  return Array.from(el.classList).some((c) => c.includes(substr))
}

describe('PipelineStepper', () => {
  test('renders all 7 stage labels in every state', () => {
    const states = [null, 'screening', 'diligence', 'decision', 'documentation', 'portfolio', 'pass']
    for (const currentValue of states) {
      const { unmount } = render(
        <PipelineStepper
          stages={COMPANY_PIPELINE_STAGES_FULL}
          currentValue={currentValue}
          daysInStage={3}
        />,
      )
      for (const label of STAGE_LABELS) {
        // Label appears both as the dot's title attr and the visible span.
        // getAllByText finds the span; presence is all we need.
        expect(screen.getAllByText(label).length).toBeGreaterThan(0)
      }
      unmount()
    }
  })

  test('halo dot lands on the right index per active state', () => {
    const cases: Array<{ currentValue: string | null; expectedHaloIdx: number }> = [
      { currentValue: null, expectedHaloIdx: 0 },
      { currentValue: 'screening', expectedHaloIdx: 1 },
      { currentValue: 'diligence', expectedHaloIdx: 2 },
      { currentValue: 'decision', expectedHaloIdx: 3 },
      { currentValue: 'documentation', expectedHaloIdx: 4 },
      { currentValue: 'portfolio', expectedHaloIdx: 5 },
    ]
    for (const { currentValue, expectedHaloIdx } of cases) {
      const { container, unmount } = render(
        <PipelineStepper
          stages={COMPANY_PIPELINE_STAGES_FULL}
          currentValue={currentValue}
          daysInStage={1}
        />,
      )
      const dots = getDots(container)
      const haloed = dots.map((d) => hasClassContaining(d, 'dotCurrent'))
      const expected = dots.map((_, i) => i === expectedHaloIdx)
      expect(haloed).toEqual(expected)
      unmount()
    }
  })

  test('legacy Pass state (no passedFromStage) — all dots gray, wrapper has passedTrack', () => {
    const { container } = render(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="pass"
        passedFromStage={null}
        daysInStage={0}
      />,
    )
    const dots = getDots(container)
    for (const d of dots) {
      expect(hasClassContaining(d, 'dotCurrent')).toBe(false)
      expect(hasClassContaining(d, 'dotCompleted')).toBe(false)
    }
    // Wrapper (outermost div) should carry the passedTrack class.
    const wrapper = container.firstChild as HTMLElement
    expect(hasClassContaining(wrapper, 'passedTrack')).toBe(true)
  })

  test('Pass state with passedFromStage="diligence" — fills up to Diligence, halo on Pass, no passedTrack mute', () => {
    const { container } = render(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="pass"
        passedFromStage="diligence"
        daysInStage={0}
      />,
    )
    const dots = getDots(container)
    // Indices: 0 Sourced, 1 Screening, 2 Diligence, 3 Partner, 4 Term Sheet,
    // 5 Portfolio, 6 Pass. Expect 0–2 completed, 3–5 future, 6 current.
    const completed = dots.map((d) => hasClassContaining(d, 'dotCompleted'))
    expect(completed).toEqual([true, true, true, false, false, false, false])
    const halos = dots.map((d) => hasClassContaining(d, 'dotCurrent'))
    expect(halos).toEqual([false, false, false, false, false, false, true])
    const wrapper = container.firstChild as HTMLElement
    expect(hasClassContaining(wrapper, 'passedTrack')).toBe(false)
  })

  test('right-side caption renders "Passed today" / "Passed · 3d ago" in full', () => {
    const { rerender } = render(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="pass"
        daysInStage={0}
      />,
    )
    expect(screen.getByText('Passed today')).toBeInTheDocument()
    rerender(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="pass"
        daysInStage={3}
      />,
    )
    expect(screen.getByText(/Passed · 3d ago/)).toBeInTheDocument()
  })

  test('click Portfolio dot in Pass state opens confirm dialog citing Portfolio', () => {
    const { container } = render(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="pass"
        passedFromStage="diligence"
        daysInStage={0}
        onStageClick={() => {}}
      />,
    )
    const dots = getDots(container)
    fireEvent.click(dots[5]) // Portfolio
    expect(screen.getByText('Re-open this passed deal?')).toBeInTheDocument()
    // Dialog body wraps the stage label in <strong>. Scope to the dialog's
    // <strong> child so we don't collide with the row label.
    const strong = container.querySelector('strong')
    expect(strong?.textContent).toBe('Portfolio')
  })

  test('no segment is rendered between Portfolio and Pass', () => {
    const { container } = render(
      <PipelineStepper
        stages={COMPANY_PIPELINE_STAGES_FULL}
        currentValue="documentation"
        daysInStage={1}
      />,
    )
    // Segments are the only elements positioned on grid row 1 with an EVEN
    // column (dots sit on odd columns 1, 3, 5, ...). 7 stages → 6 between-dot
    // slots, but the slot leading INTO the Pass dot is suppressed in JSX, so
    // exactly 5 segments.
    const segments = Array.from(container.querySelectorAll('div')).filter((el) => {
      const row = (el as HTMLElement).style.gridRow
      const col = parseInt((el as HTMLElement).style.gridColumn, 10)
      return row === '1' && !Number.isNaN(col) && col % 2 === 0
    })
    expect(segments.length).toBe(5)
  })
})
