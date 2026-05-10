// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('../renderer/components/crm/PropertiesCard.module.css', () => ({
  default: {
    card: 'card',
    topBand: 'topBand',
    sections: 'sections',
    footer: 'footer',
    hiddenLink: 'hiddenLink',
    addPropBtn: 'addPropBtn',
    footerExtra: 'footerExtra',
  },
}))

const { PropertiesCard, PropertiesCardFooter } = await import('../renderer/components/crm/PropertiesCard')

afterEach(() => cleanup())

describe('PropertiesCard', () => {
  it('renders children inside the sections wrapper', () => {
    const { container, getByText } = render(
      <PropertiesCard>
        <div>row 1</div>
        <div>row 2</div>
      </PropertiesCard>,
    )
    expect(container.querySelector('.card')).toBeTruthy()
    expect(container.querySelector('.sections')).toBeTruthy()
    expect(getByText('row 1')).toBeTruthy()
    expect(getByText('row 2')).toBeTruthy()
  })

  it('renders topBand slot when provided', () => {
    const { container } = render(
      <PropertiesCard topBand={<span data-testid="band">b</span>}>
        <div>x</div>
      </PropertiesCard>,
    )
    expect(container.querySelector('.topBand')).toBeTruthy()
    expect(container.querySelector('[data-testid="band"]')).toBeTruthy()
  })

  it('does NOT render topBand wrapper when slot is omitted', () => {
    const { container } = render(<PropertiesCard><div>x</div></PropertiesCard>)
    expect(container.querySelector('.topBand')).toBeFalsy()
  })

  it('renders footer slot when provided', () => {
    const { container } = render(
      <PropertiesCard footer={<span data-testid="ftr">f</span>}>
        <div>x</div>
      </PropertiesCard>,
    )
    expect(container.querySelector('.footer')).toBeTruthy()
    expect(container.querySelector('[data-testid="ftr"]')).toBeTruthy()
  })
})

describe('PropertiesCardFooter', () => {
  it('shows the hidden-count link when count > 0', () => {
    const onShow = vi.fn()
    const { getByText } = render(
      <PropertiesCardFooter hiddenCount={5} onShowHidden={onShow} />,
    )
    expect(getByText('Show 5 hidden fields')).toBeTruthy()
    fireEvent.click(getByText('Show 5 hidden fields'))
    expect(onShow).toHaveBeenCalled()
  })

  it('singularizes when hidden count = 1', () => {
    const { getByText } = render(
      <PropertiesCardFooter hiddenCount={1} onShowHidden={() => {}} />,
    )
    expect(getByText('Show 1 hidden field')).toBeTruthy()
  })

  it('does NOT render the hidden link when count is 0', () => {
    const { container } = render(
      <PropertiesCardFooter hiddenCount={0} onShowHidden={() => {}} />,
    )
    expect(container.querySelector('.hiddenLink')).toBeFalsy()
  })

  it('renders + Add property button and fires onAddProperty', () => {
    const onAdd = vi.fn()
    const { getByText } = render(
      <PropertiesCardFooter hiddenCount={0} onAddProperty={onAdd} />,
    )
    fireEvent.click(getByText('+ Add property'))
    expect(onAdd).toHaveBeenCalled()
  })
})
