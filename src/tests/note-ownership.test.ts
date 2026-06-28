import { describe, it, expect } from 'vitest'
import { isForeignNote, stampReadOnly } from '../main/ipc/note-ownership'

describe('note-ownership — firm-shared read-only logic', () => {
  it('a teammate-owned note is foreign (read-only)', () => {
    expect(isForeignNote({ createdByUserId: 'teammate' }, ['me'])).toBe(true)
  })

  it("the current user's own note is not foreign", () => {
    expect(isForeignNote({ createdByUserId: 'me' }, ['me'])).toBe(false)
  })

  it("a note owned by the user's gateway id (alias) is not foreign", () => {
    // The same person has a local id + a gateway cuid2; a round-tripped note
    // comes back owned by the gateway id and must stay editable.
    expect(isForeignNote({ createdByUserId: 'gw' }, ['local', 'gw'])).toBe(false)
    // …but a genuine teammate id (not in the set) is still foreign.
    expect(isForeignNote({ createdByUserId: 'teammate' }, ['local', 'gw'])).toBe(true)
  })

  it('a note with no recorded creator is treated as own (editable)', () => {
    // Legacy/local notes created before owner-tracking → null creator.
    expect(isForeignNote({ createdByUserId: null }, ['me'])).toBe(false)
  })

  it('with no current user, an owned-by-someone note is still foreign', () => {
    expect(isForeignNote({ createdByUserId: 'teammate' }, [])).toBe(true)
    // …but a creatorless note stays editable.
    expect(isForeignNote({ createdByUserId: null }, [])).toBe(false)
  })

  it('stampReadOnly sets readOnly without mutating the input', () => {
    const own = { id: 'n1', createdByUserId: 'me' }
    const foreign = { id: 'n2', createdByUserId: 'teammate' }

    const ownStamped = stampReadOnly(own, ['me'])
    const foreignStamped = stampReadOnly(foreign, ['me'])

    expect(ownStamped).toEqual({ id: 'n1', createdByUserId: 'me', readOnly: false })
    expect(foreignStamped).toEqual({ id: 'n2', createdByUserId: 'teammate', readOnly: true })
    // input objects untouched
    expect('readOnly' in own).toBe(false)
    expect('readOnly' in foreign).toBe(false)
  })
})
