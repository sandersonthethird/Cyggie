// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import { SafeMarkdown } from '../renderer/components/SafeMarkdown'

afterEach(() => cleanup())

describe('SafeMarkdown sanitization', () => {
  describe('inert payloads', () => {
    it('strips <script> tags', () => {
      const { container } = render(<SafeMarkdown>{`Hello <script>window.x=1</script> world`}</SafeMarkdown>)
      expect(container.querySelector('script')).toBeNull()
    })

    it('strips <iframe> tags', () => {
      const { container } = render(
        <SafeMarkdown>{`<iframe src="http://attacker"></iframe>`}</SafeMarkdown>
      )
      expect(container.querySelector('iframe')).toBeNull()
    })

    it('strips onerror handlers on <img>', () => {
      const { container } = render(
        <SafeMarkdown>{`<img src="x" onerror="alert(1)" />`}</SafeMarkdown>
      )
      const img = container.querySelector('img')
      if (img) expect(img.getAttribute('onerror')).toBeNull()
    })

    it('strips javascript: hrefs on <a>', () => {
      const { container } = render(
        <SafeMarkdown>{`[click](javascript:alert(1))`}</SafeMarkdown>
      )
      const a = container.querySelector('a')
      // Either the link survives without href or href doesn't start with javascript:
      if (a?.getAttribute('href')) {
        expect(a.getAttribute('href')!.toLowerCase().startsWith('javascript:')).toBe(false)
      }
    })

    it('strips embedded <script> in SVG', () => {
      const { container } = render(
        <SafeMarkdown>{`<svg><script>alert(1)</script></svg>`}</SafeMarkdown>
      )
      expect(container.querySelector('script')).toBeNull()
    })

    it('strips style attribute on <img> (CSS-context XSS vector)', () => {
      const { container } = render(
        <SafeMarkdown>{`<img src="x" style="display:none" />`}</SafeMarkdown>
      )
      const img = container.querySelector('img')
      if (img) expect(img.getAttribute('style')).toBeNull()
    })
  })

  describe('allowed tags actually render', () => {
    it('renders <mark>', () => {
      const { container } = render(<SafeMarkdown>{`<mark>hit</mark>`}</SafeMarkdown>)
      expect(container.querySelector('mark')).not.toBeNull()
    })

    it('renders <u>', () => {
      const { container } = render(<SafeMarkdown>{`<u>under</u>`}</SafeMarkdown>)
      expect(container.querySelector('u')).not.toBeNull()
    })

    it('renders <br>', () => {
      const { container } = render(<SafeMarkdown>{`one<br>two`}</SafeMarkdown>)
      expect(container.querySelector('br')).not.toBeNull()
    })

    it('renders <details><summary>', () => {
      const { container } = render(
        <SafeMarkdown>{`<details><summary>s</summary>body</details>`}</SafeMarkdown>
      )
      expect(container.querySelector('details')).not.toBeNull()
      expect(container.querySelector('summary')).not.toBeNull()
    })

    it('renders <sup>', () => {
      const { container } = render(<SafeMarkdown>{`x<sup>2</sup>`}</SafeMarkdown>)
      expect(container.querySelector('sup')).not.toBeNull()
    })

    it('preserves GFM tables', () => {
      const { container } = render(
        <SafeMarkdown>{`| h |\n| - |\n| c |`}</SafeMarkdown>
      )
      expect(container.querySelector('table')).not.toBeNull()
    })

    it('preserves syntax-highlight className on <code>', () => {
      const { container } = render(
        <SafeMarkdown>{'```ts\nconst x = 1\n```'}</SafeMarkdown>
      )
      const code = container.querySelector('code')
      expect(code?.className).toMatch(/language-ts/)
    })
  })

  describe('streaming-chunk safety', () => {
    it.each([
      ['<scr'],
      ['<scrip'],
      ['<script'],
      ['<script>'],
      ['<script>alert(1)'],
      ['<script>alert(1)</script>'],
    ])('renders chunk %j with no <script> element', (chunk) => {
      const { container } = render(<SafeMarkdown>{chunk}</SafeMarkdown>)
      expect(container.querySelector('script')).toBeNull()
    })
  })

  describe('findHighlight path', () => {
    it('renders <mark> around matched positions', () => {
      const text = 'hello world hello'
      const matches = [
        { start: 0, end: 5 },
        { start: 12, end: 17 },
      ]
      const { container } = render(
        <SafeMarkdown findHighlight={{ matches, activeIndex: 0 }}>{text}</SafeMarkdown>
      )
      const marks = container.querySelectorAll('mark')
      expect(marks.length).toBe(2)
      expect(marks[0].textContent).toBe('hello')
      expect(marks[1].textContent).toBe('hello')
    })

    it('marks the active match with className="markActive"', () => {
      const text = 'a b'
      const matches = [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ]
      const { container } = render(
        <SafeMarkdown findHighlight={{ matches, activeIndex: 1 }}>{text}</SafeMarkdown>
      )
      const marks = container.querySelectorAll('mark')
      expect(marks.length).toBe(2)
      const active = Array.from(marks).filter((m) => m.classList.contains('markActive'))
      expect(active.length).toBe(1)
      expect(active[0].textContent).toBe('b')
    })

    it('does not let a <script> payload survive even when findHighlight is set', () => {
      const text = 'hello <script>alert(1)</script> world'
      const matches = [{ start: 0, end: 5 }]
      const { container } = render(
        <SafeMarkdown findHighlight={{ matches, activeIndex: 0 }}>{text}</SafeMarkdown>
      )
      expect(container.querySelector('script')).toBeNull()
    })
  })
})
