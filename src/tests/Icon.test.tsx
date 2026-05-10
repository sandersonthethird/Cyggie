// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import { Icon } from '../renderer/components/common/Icon'

afterEach(() => cleanup())

describe('Icon', () => {
  it('renders an svg with default size 12 and 24 viewBox', () => {
    const { container } = render(<Icon name="globe" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg!.getAttribute('width')).toBe('12')
    expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('respects size prop', () => {
    const { container } = render(<Icon name="user" size={24} />)
    const svg = container.querySelector('svg')
    expect(svg!.getAttribute('width')).toBe('24')
  })

  it('renders unknown name as circle-dashed and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(<Icon name="not-a-real-icon" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    // circle-dashed renders a single dashed circle
    expect(svg!.querySelector('circle[stroke-dasharray]')).toBeTruthy()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/unknown icon name/i)
    warn.mockRestore()
  })

  it('falls back to circle-dashed when name is undefined without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(<Icon name={undefined} />)
    const svg = container.querySelector('svg')
    expect(svg!.querySelector('circle[stroke-dasharray]')).toBeTruthy()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
