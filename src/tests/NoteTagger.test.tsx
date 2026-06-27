// @vitest-environment jsdom
/**
 * NoteTagger read-only mode (firm-shared notes owned by a teammate).
 *
 * Mock boundary: ../renderer/api → vi.fn() (usePicker only hits IPC on a user
 * search, which these tests never trigger, but mock it so nothing touches the
 * electron bridge).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../renderer/api', () => ({
  api: { invoke: vi.fn(), on: vi.fn(() => () => {}) },
}))

const { NoteTagger } = await import('../renderer/components/notes/NoteTagger')

const noop = () => {}

describe('NoteTagger — read-only mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('read-only + tagged: shows chips, hides remove (×) and add buttons', () => {
    render(
      <NoteTagger
        companyId="c1"
        companyName="Acme"
        contactId="ct1"
        contactName="Jane Doe"
        onTagCompany={noop}
        onTagContact={noop}
        readOnly
      />,
    )
    // Chips render for context.
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('Jane Doe')).toBeTruthy()
    // No edit affordances.
    expect(screen.queryByTitle('Remove company tag')).toBeNull()
    expect(screen.queryByTitle('Remove contact tag')).toBeNull()
    expect(screen.queryByText('+ Company')).toBeNull()
    expect(screen.queryByText('+ Contact')).toBeNull()
  })

  it('read-only + untagged: renders no add buttons (nothing to show)', () => {
    render(
      <NoteTagger
        companyId={null}
        companyName={null}
        contactId={null}
        contactName={null}
        onTagCompany={noop}
        onTagContact={noop}
        readOnly
      />,
    )
    expect(screen.queryByText('+ Company')).toBeNull()
    expect(screen.queryByText('+ Contact')).toBeNull()
  })

  it('editable + tagged: still shows the remove (×) buttons', () => {
    render(
      <NoteTagger
        companyId="c1"
        companyName="Acme"
        contactId="ct1"
        contactName="Jane Doe"
        onTagCompany={noop}
        onTagContact={noop}
      />,
    )
    expect(screen.getByTitle('Remove company tag')).toBeTruthy()
    expect(screen.getByTitle('Remove contact tag')).toBeTruthy()
  })

  it('editable + untagged: shows the add buttons', () => {
    render(
      <NoteTagger
        companyId={null}
        companyName={null}
        contactId={null}
        contactName={null}
        onTagCompany={noop}
        onTagContact={noop}
      />,
    )
    expect(screen.getByText('+ Company')).toBeTruthy()
    expect(screen.getByText('+ Contact')).toBeTruthy()
  })
})
