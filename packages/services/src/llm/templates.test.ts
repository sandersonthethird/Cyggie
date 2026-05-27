import { describe, expect, it } from 'vitest'
import { buildPrompt, AUTHORITATIVE_ATTENDEES_INSTRUCTION } from './templates'
import type { MeetingTemplate } from '@shared/types/template'

// A minimal template that mirrors the V1 VC Pitch shape: references
// {{attendees}} in the header and {{transcript}} in the body. Pure
// userPromptTemplate (no `instructions`-driven path).
const TEMPLATE: MeetingTemplate = {
  id: 't1',
  name: 'Test',
  description: '',
  category: 'vc_pitch',
  systemPrompt: 'SYS',
  userPromptTemplate: [
    'Meeting: {{meeting_title}}',
    'Date: {{date}}',
    'Duration: {{duration}}',
    'Attendees: {{attendees}}',
    '',
    'Transcript:',
    '{{transcript}}',
  ].join('\n'),
  instructions: null,
  outputFormat: 'markdown',
  isDefault: true,
  isActive: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
}

function baseContext(overrides: Partial<Parameters<typeof buildPrompt>[1]> = {}) {
  return {
    transcript: 'Speaker 0: hi\nSpeaker 1: hello',
    meetingTitle: 'Birdwatch pitch',
    date: '5/26/2026',
    duration: '43 minutes',
    speakers: ['Speaker 0', 'Speaker 1'],
    ...overrides,
  }
}

describe('buildPrompt — attendees rendering', () => {
  it('1. renders [selfName + attendees] when both present, with authority', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: ['Chris Rosenbaum'], selfName: 'Sandy Cass' }),
    )
    expect(userPrompt).toContain('Attendees: Sandy Cass (meeting owner), Chris Rosenbaum')
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('2. omits owner when selfName is null but attendees has items (firm-shared guard)', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: ['Chris Rosenbaum'], selfName: null }),
    )
    // No "(meeting owner)" fragment — we don't fabricate an owner.
    expect(userPrompt).not.toContain('(meeting owner)')
    expect(userPrompt).toContain('Attendees: Chris Rosenbaum')
    // Authority claim still asserted — calendar truth is known.
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('3. renders just owner when attendees is empty array + selfName set', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: [], selfName: 'Sandy Cass' }),
    )
    expect(userPrompt).toContain('Attendees: Sandy Cass (meeting owner)')
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('4. falls back to placeholder when both attendees=[] AND selfName=null', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: [], selfName: null }),
    )
    expect(userPrompt).toContain('Attendees: (no attendees recorded)')
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('5. falls back to speakerMap + suppresses authority when attendees is null', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: null, selfName: null }),
    )
    expect(userPrompt).toContain('Attendees: Speaker 0, Speaker 1')
    expect(userPrompt).not.toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('6. trims whitespace on selfName + attendees entries', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({
        attendees: ['  Chris  ', '', '  '],
        selfName: '  Sandy Cass  ',
      }),
    )
    // Empty / whitespace-only entries dropped; surviving entries trimmed.
    expect(userPrompt).toContain('Attendees: Sandy Cass (meeting owner), Chris')
    expect(userPrompt).not.toMatch(/Attendees:.*?, ,/)
  })

  it('regression: does NOT contain the legacy "Participants: {{speakers}}" header', () => {
    const { userPrompt } = buildPrompt(
      TEMPLATE,
      baseContext({ attendees: ['Chris'], selfName: 'Sandy' }),
    )
    expect(userPrompt).not.toContain('Participants:')
    expect(userPrompt).not.toContain('{{speakers}}')
  })
})
