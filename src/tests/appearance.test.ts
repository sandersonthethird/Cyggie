import { describe, it, expect } from 'vitest'
import {
  DEFAULTS,
  applyAppearance,
  tokensFor,
  validate,
  type AppearancePrefs,
} from '../renderer/lib/appearance'

/** Minimal stand-in for an element's style, so applyAppearance can run under
 *  the node test env without a DOM. */
function styleStub() {
  const props = new Map<string, string>()
  const el = {
    style: {
      setProperty(name: string, value: string) {
        props.set(name, value)
      },
    },
  }
  return { el: el as unknown as HTMLElement, props }
}

describe('appearance.validate', () => {
  it('passes through a fully valid prefs object', () => {
    const valid: AppearancePrefs = { lineSpacing: 'relaxed', fontSize: 'l', lineWidth: 'narrow' }
    expect(validate(valid)).toEqual(valid)
  })

  it('clamps each unknown field to its default independently', () => {
    expect(validate({ lineSpacing: 'huge', fontSize: 'm', lineWidth: 'zzz' })).toEqual({
      lineSpacing: DEFAULTS.lineSpacing,
      fontSize: 'm',
      lineWidth: DEFAULTS.lineWidth,
    })
  })

  it.each([null, undefined, 42, 'nonsense', [], { lineSpacing: 123 }])(
    'returns DEFAULTS for garbage input: %s',
    (garbage) => {
      expect(validate(garbage)).toEqual(DEFAULTS)
    },
  )
})

describe('appearance.tokensFor', () => {
  it('maps the default prefs to the historical look (lh 1.6 / gap 0.75em / 1em / full)', () => {
    expect(tokensFor(DEFAULTS)).toEqual({
      '--cy-reading-lh': '1.6',
      '--cy-reading-gap': '0.75em',
      '--cy-reading-fs': '1em',
      '--cy-reading-mw': '72rem',
    })
  })

  it('compact spacing tightens line-height and paragraph gap', () => {
    const t = tokensFor({ ...DEFAULTS, lineSpacing: 'compact' })
    expect(t['--cy-reading-lh']).toBe('1.4')
    expect(t['--cy-reading-gap']).toBe('0.35em')
  })

  it('large font + wide width', () => {
    const t = tokensFor({ lineSpacing: 'relaxed', fontSize: 'l', lineWidth: 'wide' })
    expect(t['--cy-reading-fs']).toBe('1.15em')
    expect(t['--cy-reading-mw']).toBe('100%')
    expect(t['--cy-reading-lh']).toBe('1.9')
  })
})

describe('appearance.applyAppearance', () => {
  it('sets all four custom properties on the target', () => {
    const { el, props } = styleStub()
    applyAppearance({ lineSpacing: 'compact', fontSize: 's', lineWidth: 'narrow' }, el)
    expect(props.get('--cy-reading-lh')).toBe('1.4')
    expect(props.get('--cy-reading-fs')).toBe('0.9em')
    expect(props.get('--cy-reading-mw')).toBe('46rem')
    expect(props.get('--cy-reading-gap')).toBe('0.35em')
  })

  it('falls back to defaults for a corrupt value (2am guarantee — no throw)', () => {
    const { el, props } = styleStub()
    expect(() => applyAppearance('💥 not prefs', el)).not.toThrow()
    expect(props.get('--cy-reading-lh')).toBe(tokensFor(DEFAULTS)['--cy-reading-lh'])
  })

  it('no-ops without a target and no document (does not throw)', () => {
    expect(() => applyAppearance(DEFAULTS)).not.toThrow()
  })
})
