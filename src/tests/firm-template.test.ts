import { describe, it, expect, vi } from 'vitest'
import {
  FIRM_TEMPLATES,
  resolveFirmTemplate,
  DEFAULT_FIRM_TEMPLATE_ID,
} from '../shared/firm-templates'
import { applyFirmTemplate, type ApplyFirmTemplateDeps } from '../renderer/lib/applyFirmTemplate'

// ── Registry ────────────────────────────────────────────────────────────────

describe('firm-templates registry', () => {
  it('resolves known ids, and null/unknown/forged → vc default', () => {
    expect(resolveFirmTemplate('vc').id).toBe('vc')
    expect(resolveFirmTemplate('sales').id).toBe('sales')
    expect(resolveFirmTemplate(null).id).toBe(DEFAULT_FIRM_TEMPLATE_ID)
    expect(resolveFirmTemplate(undefined).id).toBe('vc')
    expect(resolveFirmTemplate('not-a-template').id).toBe('vc')
  })

  it('vc seeds the Fund IV view; sales (non-VC) starts clean', () => {
    const vcViewIds = FIRM_TEMPLATES.vc.companyViews.map((v) => v.id)
    expect(vcViewIds).toContain('fund-iv-default')
    expect(FIRM_TEMPLATES.sales.companyViews).toHaveLength(0)
  })

  it('neither template seeds portfolioFund options (defaults stay in the shared base)', () => {
    for (const t of Object.values(FIRM_TEMPLATES)) {
      expect(t.companyFieldOptions.some((f) => f.fieldKey === 'portfolioFund')).toBe(false)
    }
  })
})

// ── applyFirmTemplate (2B idempotency + best-effort) ──────────────────────────

function makeDeps(overrides: Partial<ApplyFirmTemplateDeps> = {}): {
  deps: ApplyFirmTemplateDeps
  markers: Map<string, string>
  views: string[]
} {
  const markers = new Map<string, string>()
  const views: string[] = []
  const deps: ApplyFirmTemplateDeps = {
    getMarker: (k) => markers.get(k) ?? null,
    setMarker: (k, v) => { markers.set(k, v) },
    ensureCompanyView: (view) => { views.push(view.id) },
    mergeCompanyLabels: () => {},
    getCompanyBuiltinDef: () => undefined,
    addCompanyFieldOption: async () => {},
    now: () => '2026-06-26T00:00:00.000Z',
    log: () => {},
    ...overrides,
  }
  return { deps, markers, views }
}

describe('applyFirmTemplate', () => {
  it('seeds the vc Fund IV view and sets the marker on success', async () => {
    const { deps, markers, views } = makeDeps()
    const r = await applyFirmTemplate('vc', deps)
    expect(r).toMatchObject({ templateId: 'vc', ran: true, allOk: true })
    expect(views).toContain('fund-iv-default')
    expect(markers.get('template_applied:vc')).toBe('2026-06-26T00:00:00.000Z')
  })

  it('is idempotent: a second run with the marker present is a no-op', async () => {
    const { deps, views } = makeDeps()
    await applyFirmTemplate('vc', deps)
    const second = await applyFirmTemplate('vc', deps)
    expect(second.ran).toBe(false)
    // ensureCompanyView not called again → no duplicate seeding
    expect(views.filter((v) => v === 'fund-iv-default')).toHaveLength(1)
  })

  it('unknown template id falls back to vc and seeds the Fund IV view', async () => {
    const { deps, views, markers } = makeDeps()
    const r = await applyFirmTemplate('bogus', deps)
    expect(r.templateId).toBe('vc')
    expect(views).toContain('fund-iv-default')
    expect(markers.has('template_applied:vc')).toBe(true)
  })

  it('best-effort: a failing seed target leaves the marker UNSET so it retries', async () => {
    const log = vi.fn()
    const { deps, markers } = makeDeps({
      ensureCompanyView: () => { throw new Error('localStorage blew up') },
      log,
    })
    const r = await applyFirmTemplate('vc', deps)
    expect(r.ran).toBe(true)
    expect(r.allOk).toBe(false)
    expect(markers.has('template_applied:vc')).toBe(false) // retries next load
    expect(log).toHaveBeenCalled()
  })

  it('never throws to the caller even if a target fails', async () => {
    const { deps } = makeDeps({ ensureCompanyView: () => { throw new Error('boom') } })
    await expect(applyFirmTemplate('vc', deps)).resolves.toMatchObject({ allOk: false })
  })
})
