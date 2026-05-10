// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('../renderer/components/common/Pill.module.css', () => ({
  default: {
    pill: 'pill',
    label: 'label',
    dot: 'dot',
    avatar: 'avatar',
    'tone-neutral': 'tone-neutral',
    'tone-green': 'tone-green',
    'tone-violet': 'tone-violet',
  },
}))

const { Pill } = await import('../renderer/components/common/Pill')

afterEach(() => cleanup())

describe('Pill', () => {
  it('renders label and default neutral tone', () => {
    const { container, getByText } = render(<Pill>Hello</Pill>)
    expect(getByText('Hello')).toBeTruthy()
    expect(container.querySelector('.tone-neutral')).toBeTruthy()
  })

  it('applies tone class', () => {
    const { container } = render(<Pill tone="green">Active</Pill>)
    expect(container.querySelector('.tone-green')).toBeTruthy()
  })

  it('renders dot when dot prop set and no avatar', () => {
    const { container } = render(<Pill dot>X</Pill>)
    expect(container.querySelector('.dot')).toBeTruthy()
  })

  it('does NOT render dot when avatar is provided', () => {
    const { container } = render(<Pill dot avatar={{ initial: 'A' }}>X</Pill>)
    expect(container.querySelector('.dot')).toBeFalsy()
    expect(container.querySelector('.avatar')).toBeTruthy()
  })

  it('avatar shows initial', () => {
    const { container } = render(<Pill avatar={{ initial: 'M' }}>MBX</Pill>)
    expect(container.querySelector('.avatar')!.textContent).toBe('M')
  })

  it('is interactive when onClick provided', () => {
    const onClick = vi.fn()
    const { container } = render(<Pill onClick={onClick}>Click</Pill>)
    const pill = container.querySelector('.pill')!
    expect(pill.getAttribute('role')).toBe('button')
    fireEvent.click(pill)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('Enter key triggers onClick when interactive', () => {
    const onClick = vi.fn()
    const { container } = render(<Pill onClick={onClick}>Click</Pill>)
    fireEvent.keyDown(container.querySelector('.pill')!, { key: 'Enter' })
    expect(onClick).toHaveBeenCalled()
  })

  it('is non-interactive when no onClick', () => {
    const { container } = render(<Pill>X</Pill>)
    expect(container.querySelector('.pill')!.getAttribute('role')).toBeNull()
  })
})
