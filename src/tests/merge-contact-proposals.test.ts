import { describe, it, expect } from 'vitest'
import { mergeContactProposals } from '../shared/utils/contact-proposal-utils'
import type { ContactSummaryUpdateProposal } from '../shared/types/summary'

function makeProposal(overrides: Partial<ContactSummaryUpdateProposal> & { contactId: string; contactName: string }): ContactSummaryUpdateProposal {
  return {
    changes: [],
    updates: {},
    ...overrides,
  }
}

describe('mergeContactProposals', () => {
  it('returns a single proposal unchanged', () => {
    const proposal = makeProposal({
      contactId: 'c1',
      contactName: 'Alice',
      updates: { title: 'CEO' },
      changes: [{ field: 'title', from: null, to: 'CEO' }],
    })
    const result = mergeContactProposals([proposal])
    expect(result).toHaveLength(1)
    expect(result[0].updates.title).toBe('CEO')
  })

  it('keeps proposals for different contacts separate', () => {
    const p1 = makeProposal({ contactId: 'c1', contactName: 'Alice', updates: { title: 'CEO' }, changes: [] })
    const p2 = makeProposal({ contactId: 'c2', contactName: 'Bob', updates: { title: 'CTO' }, changes: [] })
    const result = mergeContactProposals([p1, p2])
    expect(result).toHaveLength(2)
  })

  it('first meeting wins for title when same contact in two meetings', () => {
    const p1 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { title: 'CEO' },
      changes: [{ field: 'title', from: null, to: 'CEO' }],
    })
    const p2 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { title: 'Founder' },
      changes: [{ field: 'title', from: null, to: 'Founder' }],
    })
    const result = mergeContactProposals([p1, p2])
    expect(result).toHaveLength(1)
    expect(result[0].updates.title).toBe('CEO')
  })

  it('investor field from second meeting is merged in (regression for silent drop bug)', () => {
    const p1 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { title: 'Partner' },
      changes: [{ field: 'title', from: null, to: 'Partner' }],
    })
    const p2 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { fundSize: 100 },
      changes: [{ field: 'fundSize', from: null, to: '100' }],
    })
    const result = mergeContactProposals([p1, p2])
    expect(result).toHaveLength(1)
    expect(result[0].updates.title).toBe('Partner')
    expect(result[0].updates.fundSize).toBe(100)
    expect(result[0].changes).toHaveLength(2)
  })

  it('custom field from second meeting is merged in', () => {
    const customField = {
      fieldDefinitionId: 'fd1',
      label: 'Sector',
      fieldType: 'text',
      newValue: 'Fintech',
      fromDisplay: null,
      toDisplay: 'Fintech',
    }
    const p1 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { title: 'Partner' },
      changes: [{ field: 'title', from: null, to: 'Partner' }],
    })
    const p2 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: {},
      changes: [],
      customFieldUpdates: [customField],
    })
    const result = mergeContactProposals([p1, p2])
    expect(result).toHaveLength(1)
    expect(result[0].customFieldUpdates).toHaveLength(1)
    expect(result[0].customFieldUpdates![0].fieldDefinitionId).toBe('fd1')
  })

  it('custom field deduplication: same fieldDefinitionId from two meetings — first wins', () => {
    const cfu1 = { fieldDefinitionId: 'fd1', label: 'Sector', fieldType: 'text', newValue: 'Fintech', fromDisplay: null, toDisplay: 'Fintech' }
    const cfu2 = { fieldDefinitionId: 'fd1', label: 'Sector', fieldType: 'text', newValue: 'SaaS', fromDisplay: null, toDisplay: 'SaaS' }
    const p1 = makeProposal({ contactId: 'c1', contactName: 'Alice', updates: {}, changes: [], customFieldUpdates: [cfu1] })
    const p2 = makeProposal({ contactId: 'c1', contactName: 'Alice', updates: {}, changes: [], customFieldUpdates: [cfu2] })
    const result = mergeContactProposals([p1, p2])
    expect(result[0].customFieldUpdates).toHaveLength(1)
    expect(result[0].customFieldUpdates![0].toDisplay).toBe('Fintech')
  })

  it('companyLink: first wins', () => {
    const p1 = makeProposal({
      contactId: 'c1', contactName: 'Alice', updates: {}, changes: [],
      companyLink: { companyId: 'co1', companyName: 'Acme' },
    })
    const p2 = makeProposal({
      contactId: 'c1', contactName: 'Alice', updates: {}, changes: [],
      companyLink: { companyId: 'co2', companyName: 'Beta Corp' },
    })
    const result = mergeContactProposals([p1, p2])
    expect(result[0].companyLink?.companyName).toBe('Acme')
  })

  it('fieldSources: last meeting wins', () => {
    const p1 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { fieldSources: JSON.stringify({ title: 'meeting-1' }) },
      changes: [],
    })
    const p2 = makeProposal({
      contactId: 'c1', contactName: 'Alice',
      updates: { fieldSources: JSON.stringify({ title: 'meeting-2' }) },
      changes: [],
    })
    const result = mergeContactProposals([p1, p2])
    const sources = JSON.parse(result[0].updates.fieldSources!)
    expect(sources.title).toBe('meeting-2')
  })
})
