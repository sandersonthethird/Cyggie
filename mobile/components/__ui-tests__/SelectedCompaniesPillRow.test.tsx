import { render, screen, fireEvent } from '@testing-library/react-native'
import { SelectedCompaniesPillRow } from '../SelectedCompaniesPillRow'
import type { CompanyChip } from '../../lib/api/chat'

// Second MC.runner test — exercises the actual high-value pattern called
// out in the MC.runner TODO: "tap chip × → updateChatSession PATCH fires
// with the right body." We test the contract one layer down (props in,
// callbacks out) and let the MC.2 integration tests at the screen level
// cover the PATCH wiring once those land. This still catches the most
// common mutation: changing the remove-button accessibility label /
// hitbox / onPress wiring without realizing.

function makeChip(overrides: Partial<CompanyChip> = {}): CompanyChip {
  return {
    id: 'co_default',
    name: 'Default Co',
    industry: null,
    stage: null,
    primaryDomain: null,
    ...overrides,
  }
}

describe('SelectedCompaniesPillRow', () => {
  test('empty list — renders the "+" chip with the hint copy and no × buttons', () => {
    render(
      <SelectedCompaniesPillRow
        companies={[]}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    )

    // The "+" affordance carries the empty-state accessibility label.
    expect(screen.getByLabelText('Add company context')).toBeOnTheScreen()
    // No × button exists when there are no chips.
    expect(screen.queryAllByLabelText(/^Remove /)).toHaveLength(0)
  })

  test('two companies — renders two chips, two × buttons, and the "+" without hint copy', () => {
    const onRemove = jest.fn()
    const onAdd = jest.fn()
    render(
      <SelectedCompaniesPillRow
        companies={[
          makeChip({ id: 'co_1', name: 'Acme Inc' }),
          makeChip({ id: 'co_2', name: 'Globex' }),
        ]}
        onRemove={onRemove}
        onAdd={onAdd}
      />,
    )

    expect(screen.getByText('Acme Inc')).toBeOnTheScreen()
    expect(screen.getByText('Globex')).toBeOnTheScreen()
    expect(screen.getAllByLabelText(/^Remove /)).toHaveLength(2)

    // The "+" chip carries the populated-state label, NOT the empty hint.
    expect(screen.getByLabelText('Add another company')).toBeOnTheScreen()
    expect(screen.queryByLabelText('Add company context')).toBeNull()
  })

  test('tapping the × on a chip fires onRemove with the right company id', () => {
    const onRemove = jest.fn()
    render(
      <SelectedCompaniesPillRow
        companies={[
          makeChip({ id: 'co_1', name: 'Acme Inc' }),
          makeChip({ id: 'co_2', name: 'Globex' }),
        ]}
        onRemove={onRemove}
        onAdd={() => {}}
      />,
    )

    fireEvent.press(screen.getByLabelText('Remove Acme Inc'))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('co_1')

    fireEvent.press(screen.getByLabelText('Remove Globex'))
    expect(onRemove).toHaveBeenCalledTimes(2)
    expect(onRemove).toHaveBeenLastCalledWith('co_2')
  })

  test('tapping the "+" chip fires onAdd', () => {
    const onAdd = jest.fn()
    render(
      <SelectedCompaniesPillRow
        companies={[makeChip({ id: 'co_1', name: 'Acme Inc' })]}
        onRemove={() => {}}
        onAdd={onAdd}
      />,
    )

    fireEvent.press(screen.getByLabelText('Add another company'))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  test('disabled=true — × buttons hidden and "+" is non-functional', () => {
    const onRemove = jest.fn()
    const onAdd = jest.fn()
    render(
      <SelectedCompaniesPillRow
        companies={[makeChip({ id: 'co_1', name: 'Acme Inc' })]}
        onRemove={onRemove}
        onAdd={onAdd}
        disabled
      />,
    )

    // No remove buttons when disabled.
    expect(screen.queryAllByLabelText(/^Remove /)).toHaveLength(0)

    // The "+" element still renders (for visual continuity) but tapping
    // is a no-op because the Pressable is `disabled`. RN's fireEvent.press
    // ignores disabled Pressables.
    const addBtn = screen.getByLabelText('Add another company')
    expect(addBtn).toBeOnTheScreen()
    fireEvent.press(addBtn)
    expect(onAdd).not.toHaveBeenCalled()
  })
})
