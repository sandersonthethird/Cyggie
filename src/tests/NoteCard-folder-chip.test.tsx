// @vitest-environment jsdom
/**
 * Tests for the folder chip on the Notes view's NoteCard.
 *
 * The chip shows the last segment of `note.folderPath` so users can tell
 * which folder a note lives in while viewing "All Notes". It's hidden when
 * the user is already filtered to that exact folder — the chip would just
 * repeat the sidebar selection.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import type { Note } from '../shared/types/note'

vi.mock('../renderer/routes/Notes.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const { NoteCard } = await import('../renderer/routes/Notes')

afterEach(() => cleanup())

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q1 planning notes',
    content: 'body',
    companyId: null,
    contactId: null,
    sourceMeetingId: null,
    themeId: null,
    isPinned: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-05-19T10:00:00Z',
    updatedAt: '2026-05-19T10:00:00Z',
    folderPath: null,
    importSource: null,
    companyName: null,
    contactName: null,
    meetingTitle: null,
    ...overrides,
  }
}

const NOOP_CLICK = () => {}
const NOOP_CHECK = () => {}

describe('NoteCard folder chip', () => {
  it('renders the last path segment when folderPath is set and differs from currentFolder', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: 'Work/Q1' })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder={null}
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    const folder = container.querySelector('.noteFolder')
    expect(folder).not.toBeNull()
    expect(folder!.textContent).toBe('Q1')
  })

  it('renders the full path as the title attribute (hover tooltip)', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: 'Work/Q1' })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder={null}
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    const folder = container.querySelector('.noteFolder')
    expect(folder!.getAttribute('title')).toBe('Work/Q1')
  })

  it('does NOT render the chip when currentFolder equals folderPath', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: 'Work/Q1' })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder="Work/Q1"
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    expect(container.querySelector('.noteFolder')).toBeNull()
  })

  it('does NOT render the chip when folderPath is null', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: null })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder={null}
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    expect(container.querySelector('.noteFolder')).toBeNull()
  })

  it('does NOT render the chip when folderPath is an empty string', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: '' })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder={null}
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    expect(container.querySelector('.noteFolder')).toBeNull()
  })

  it('renders a chip for a top-level folder (no slash)', () => {
    const { container } = render(
      <NoteCard
        note={makeNote({ folderPath: 'Skills' })}
        index={0}
        isActive={false}
        isSelected={false}
        bulkMode={false}
        currentFolder={null}
        onCardClick={NOOP_CLICK}
        onCheckbox={NOOP_CHECK}
      />,
    )
    expect(container.querySelector('.noteFolder')!.textContent).toBe('Skills')
  })
})
