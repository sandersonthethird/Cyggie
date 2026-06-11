/**
 * Tests that buildPrompt injects the grounding trailers correctly:
 *   • ANTI_FABRICATION_INSTRUCTION  → on EVERY prompt (default + custom templates)
 *   • AUTHORITATIVE_COMPANY_INSTRUCTION → only when the meeting is linked to a
 *     known CRM company (context.companies non-empty)
 *
 * buildPrompt is a pure function over types, so no mocking is needed.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPrompt,
  ANTI_FABRICATION_INSTRUCTION,
  AUTHORITATIVE_COMPANY_INSTRUCTION,
  type PromptContext,
} from '@cyggie/services/llm/templates'
import type { MeetingTemplate } from '@shared/types/template'

function makeTemplate(overrides: Partial<MeetingTemplate> = {}): MeetingTemplate {
  return {
    id: 't1',
    name: 'VC Pitch',
    description: '',
    category: 'vc_pitch',
    systemPrompt: 'You are an analyst.',
    userPromptTemplate: 'Summarize:\n{{transcript}}',
    instructions: null,
    outputFormat: 'markdown',
    isDefault: true,
    isActive: true,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    transcript: 'Founder said revenue is $1M ARR.',
    meetingTitle: 'Pitch',
    date: '2026-06-10',
    duration: '30 minutes',
    speakers: ['Founder', 'Investor'],
    attendees: null,
    ...overrides,
  }
}

describe('buildPrompt — anti-fabrication grounding', () => {
  it('injects ANTI_FABRICATION_INSTRUCTION for a default template', () => {
    const { userPrompt } = buildPrompt(makeTemplate(), makeContext())
    expect(userPrompt).toContain(ANTI_FABRICATION_INSTRUCTION)
  })

  it('injects ANTI_FABRICATION_INSTRUCTION even with no company/attendees', () => {
    const { userPrompt } = buildPrompt(makeTemplate(), makeContext({ companies: [] }))
    expect(userPrompt).toContain(ANTI_FABRICATION_INSTRUCTION)
  })

  it('injects ANTI_FABRICATION_INSTRUCTION for an instructions-based custom template', () => {
    const tmpl = makeTemplate({
      category: 'custom',
      instructions: 'Write a one-paragraph recap.',
    })
    const { userPrompt } = buildPrompt(tmpl, makeContext())
    expect(userPrompt).toContain(ANTI_FABRICATION_INSTRUCTION)
  })
})

describe('buildPrompt — authoritative company name', () => {
  it('injects AUTHORITATIVE_COMPANY_INSTRUCTION when a company is linked', () => {
    const { userPrompt } = buildPrompt(makeTemplate(), makeContext({ companies: ['Shepherd AI'] }))
    expect(userPrompt).toContain(AUTHORITATIVE_COMPANY_INSTRUCTION)
    expect(userPrompt).toContain('Company: Shepherd AI')
  })

  it('omits AUTHORITATIVE_COMPANY_INSTRUCTION when no company is linked', () => {
    const { userPrompt } = buildPrompt(makeTemplate(), makeContext({ companies: undefined }))
    expect(userPrompt).not.toContain(AUTHORITATIVE_COMPANY_INSTRUCTION)
  })

  it('omits it when companies is an empty array', () => {
    const { userPrompt } = buildPrompt(makeTemplate(), makeContext({ companies: [] }))
    expect(userPrompt).not.toContain(AUTHORITATIVE_COMPANY_INSTRUCTION)
  })
})
