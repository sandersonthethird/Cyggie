import React from 'react'
import { Pressable } from 'react-native'
import { render, screen, fireEvent } from '@testing-library/react-native'

// Mock the entity pickers: when open, render a single "pick fixture" button
// that fires onPick with a canned entity. Lets us assert NoteTagger's
// chip/button wiring (props in, callbacks out) without the picker internals.
jest.mock('../CompanyPicker', () => {
  const { Pressable: P } = require('react-native')
  const React_ = require('react')
  return {
    CompanyPicker: ({ open, onPick }: { open: boolean; onPick: (c: { id: string; name: string }) => void }) =>
      open
        ? React_.createElement(P, {
            accessibilityLabel: 'pick-company-fixture',
            onPress: () => onPick({ id: 'co1', name: 'Acme' }),
          })
        : null,
  }
})
jest.mock('../ContactPicker', () => {
  const { Pressable: P } = require('react-native')
  const React_ = require('react')
  return {
    ContactPicker: ({ open, onPick }: { open: boolean; onPick: (c: { id: string; fullName: string }) => void }) =>
      open
        ? React_.createElement(P, {
            accessibilityLabel: 'pick-contact-fixture',
            onPress: () => onPick({ id: 'ct1', fullName: 'Jane Doe' }),
          })
        : null,
  }
})

import { NoteTagger } from '../NoteTagger'

const baseProps = {
  companyId: null,
  companyName: null,
  contactId: null,
  contactName: null,
  onTagCompany: () => {},
  onTagContact: () => {},
}

describe('NoteTagger', () => {
  test('untagged — shows "+ Company" / "+ Contact" buttons, no chips', () => {
    render(<NoteTagger {...baseProps} />)
    expect(screen.getByLabelText('Tag company')).toBeOnTheScreen()
    expect(screen.getByLabelText('Tag contact')).toBeOnTheScreen()
    expect(screen.queryByLabelText('Remove company tag')).toBeNull()
  })

  test('picking a company fires onTagCompany(id, name)', () => {
    const onTagCompany = jest.fn()
    render(<NoteTagger {...baseProps} onTagCompany={onTagCompany} />)
    fireEvent.press(screen.getByLabelText('Tag company')) // opens the mock picker
    fireEvent.press(screen.getByLabelText('pick-company-fixture'))
    expect(onTagCompany).toHaveBeenCalledWith('co1', 'Acme')
  })

  test('tagged — renders the chip and clearing fires onTagCompany(null, null)', () => {
    const onTagCompany = jest.fn()
    render(
      <NoteTagger
        {...baseProps}
        companyId="co1"
        companyName="Acme"
        onTagCompany={onTagCompany}
      />,
    )
    expect(screen.getByText('Acme')).toBeOnTheScreen()
    fireEvent.press(screen.getByLabelText('Remove company tag'))
    expect(onTagCompany).toHaveBeenCalledWith(null, null)
  })

  test('picking a contact fires onTagContact(id, name)', () => {
    const onTagContact = jest.fn()
    render(<NoteTagger {...baseProps} onTagContact={onTagContact} />)
    fireEvent.press(screen.getByLabelText('Tag contact'))
    fireEvent.press(screen.getByLabelText('pick-contact-fixture'))
    expect(onTagContact).toHaveBeenCalledWith('ct1', 'Jane Doe')
  })
})

// Keep React/Pressable imports referenced for the JSX runtime + mock typing.
void React
void Pressable
