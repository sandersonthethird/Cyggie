// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('../renderer/components/crm/CollapsibleSection.module.css', () => ({
  default: {
    section: 'section',
    header: 'header',
    chevron: 'chevron',
    title: 'title',
    count: 'count',
    countEmpty: 'countEmpty',
    addBtn: 'addBtn',
    body: 'body',
    bodyInner: 'bodyInner',
  },
}))

const { CollapsibleSection } = await import('../renderer/components/crm/CollapsibleSection')

afterEach(() => cleanup())

describe('CollapsibleSection', () => {
  it('renders title, count, and child body', () => {
    const { getByText, container } = render(
      <CollapsibleSection title="Overview" count={3} isCollapsed={false} onToggle={() => {}}>
        <div>row content</div>
      </CollapsibleSection>,
    )
    expect(getByText('Overview')).toBeTruthy()
    expect(container.querySelector('.count')!.textContent).toBe('3')
    expect(getByText('row content')).toBeTruthy()
  })

  it('aria-expanded=true when not collapsed', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={false} onToggle={() => {}}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.header')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('aria-expanded=false when collapsed', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={true} onToggle={() => {}}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.header')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('calls onToggle when header clicked', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={false} onToggle={onToggle}>
        <div>r</div>
      </CollapsibleSection>,
    )
    fireEvent.click(container.querySelector('.header')!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('Enter key toggles', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={false} onToggle={onToggle}>
        <div>r</div>
      </CollapsibleSection>,
    )
    fireEvent.keyDown(container.querySelector('.header')!, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalled()
  })

  it('"+ Add" click does NOT toggle the section (stopPropagation)', () => {
    const onToggle = vi.fn()
    const onAdd = vi.fn()
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={false} onToggle={onToggle} onAdd={onAdd}>
        <div>r</div>
      </CollapsibleSection>,
    )
    fireEvent.click(container.querySelector('.addBtn')!)
    expect(onAdd).toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('"+ Add" not rendered when onAdd is omitted', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={1} isCollapsed={false} onToggle={() => {}}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.addBtn')).toBeFalsy()
  })

  it('count=0 renders "empty" label, not "0"', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={0} isCollapsed={false} onToggle={() => {}}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.count')!.textContent).toBe('empty')
  })

  it('auto-collapses when count=0 and user has not manually toggled', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={0} isCollapsed={false} onToggle={() => {}} hasUserToggled={false}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.header')!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.body')!.getAttribute('data-collapsed')).toBe('true')
  })

  it('respects user manual expand even when empty', () => {
    const { container } = render(
      <CollapsibleSection title="X" count={0} isCollapsed={false} onToggle={() => {}} hasUserToggled={true}>
        <div>r</div>
      </CollapsibleSection>,
    )
    expect(container.querySelector('.header')!.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.body')!.getAttribute('data-collapsed')).toBe('false')
  })
})
