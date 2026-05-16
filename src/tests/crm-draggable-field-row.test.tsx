// @vitest-environment jsdom
/**
 * Tests for shared DraggableFieldRow atom.
 *
 *   isEditing=true   → draggable + drag handle rendered
 *   isEditing=false  → not draggable + no drag handle
 *   isDragTarget=true → indicator class applied
 *   drag events propagate to caller callbacks
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const { DraggableFieldRow } = await import('../renderer/components/crm/DraggableFieldRow')

afterEach(() => cleanup())

function defaults() {
  return {
    isEditing: false,
    isDragTarget: false,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
  }
}

describe('DraggableFieldRow', () => {
  it('isEditing=false: not draggable, no drag handle', () => {
    const { container } = render(
      <DraggableFieldRow {...defaults()}>
        <span>content</span>
      </DraggableFieldRow>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.getAttribute('draggable')).toBe('false')
    // No "⠿" drag-handle character anywhere
    expect(container.textContent).not.toContain('⠿')
  })

  it('isEditing=true: draggable + drag handle rendered', () => {
    const { container } = render(
      <DraggableFieldRow {...defaults()} isEditing={true}>
        <span>content</span>
      </DraggableFieldRow>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.getAttribute('draggable')).toBe('true')
    expect(container.textContent).toContain('⠿')
  })

  it('isDragTarget=true: indicator class applied', () => {
    const { container } = render(
      <DraggableFieldRow {...defaults()} isDragTarget={true}>
        <span>content</span>
      </DraggableFieldRow>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('dragOverFieldIndicator')
  })

  it('isDragTarget=false: indicator class NOT applied', () => {
    const { container } = render(
      <DraggableFieldRow {...defaults()}>
        <span>content</span>
      </DraggableFieldRow>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).not.toContain('dragOverFieldIndicator')
  })

  it('dragStart / dragEnd / dragOver / drop callbacks fire', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    const onDragOver = vi.fn()
    const onDrop = vi.fn()
    const { container } = render(
      <DraggableFieldRow
        {...defaults()}
        isEditing={true}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <span>content</span>
      </DraggableFieldRow>,
    )
    const wrapper = container.firstChild as HTMLElement
    fireEvent.dragStart(wrapper)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    fireEvent.dragOver(wrapper)
    expect(onDragOver).toHaveBeenCalledTimes(1)
    fireEvent.drop(wrapper)
    expect(onDrop).toHaveBeenCalledTimes(1)
    fireEvent.dragEnd(wrapper)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })
})
