import { describe, it, expect } from 'vitest'
import {
  kebabReducer,
  initialKebabState,
  type KebabMenuItem,
  type KebabState,
} from '../renderer/components/common/RecordKebabMenu'

const itemA: KebabMenuItem = { label: 'A', onClick: () => {} }
const itemB: KebabMenuItem = { label: 'B', onClick: () => {} }
const subItems: KebabMenuItem[] = [itemA, itemB]

describe('kebabReducer', () => {
  it('initialKebabState is closed with no submenu', () => {
    expect(initialKebabState).toEqual({ open: false, submenu: null })
  })

  it('TOGGLE from closed opens the menu at root', () => {
    const next = kebabReducer({ open: false, submenu: null }, { type: 'TOGGLE' })
    expect(next).toEqual({ open: true, submenu: null })
  })

  it('TOGGLE from open root closes the menu', () => {
    const next = kebabReducer({ open: true, submenu: null }, { type: 'TOGGLE' })
    expect(next).toEqual({ open: false, submenu: null })
  })

  it('TOGGLE from open submenu closes AND clears submenu', () => {
    const open: KebabState = { open: true, submenu: subItems }
    const next = kebabReducer(open, { type: 'TOGGLE' })
    expect(next).toEqual({ open: false, submenu: null })
  })

  it('OPEN_SUBMENU sets submenu and keeps open=true', () => {
    const next = kebabReducer(
      { open: true, submenu: null },
      { type: 'OPEN_SUBMENU', submenu: subItems },
    )
    expect(next).toEqual({ open: true, submenu: subItems })
  })

  it('BACK while in submenu clears submenu and keeps open=true', () => {
    const next = kebabReducer({ open: true, submenu: subItems }, { type: 'BACK' })
    expect(next).toEqual({ open: true, submenu: null })
  })

  it('CLOSE from any state returns to fully closed', () => {
    expect(kebabReducer({ open: false, submenu: null }, { type: 'CLOSE' })).toEqual({
      open: false,
      submenu: null,
    })
    expect(kebabReducer({ open: true, submenu: null }, { type: 'CLOSE' })).toEqual({
      open: false,
      submenu: null,
    })
    expect(kebabReducer({ open: true, submenu: subItems }, { type: 'CLOSE' })).toEqual({
      open: false,
      submenu: null,
    })
  })
})
