import { describe, expect, it } from 'vitest'
import {
  AUTHORITATIVE_ATTENDEES_INSTRUCTION,
  findTemplate,
  substitutePlaceholders,
} from '../src/templates/meeting-summary-templates'

const baseCtx = {
  meetingTitle: 'Birdwatch pitch',
  date: '5/26/2026',
  duration: '43 minutes',
  transcript: 'Speaker 0: hi\nSpeaker 1: hello',
  notes: '',
}

describe('substitutePlaceholders — attendees rendering', () => {
  const tmpl = findTemplate('vc_pitch')!

  it('substitutes {{attendees}} verbatim', () => {
    const out = substitutePlaceholders(tmpl, {
      ...baseCtx,
      attendees: 'Sandy Cass (meeting owner), Chris Rosenbaum',
      speakers: 'Speaker 0, Speaker 1',
      hasCalendarTruth: true,
    })
    expect(out).toContain('Attendees: Sandy Cass (meeting owner), Chris Rosenbaum')
  })

  it('appends authoritative-source instruction when hasCalendarTruth is true', () => {
    const out = substitutePlaceholders(tmpl, {
      ...baseCtx,
      attendees: 'Sandy, Chris',
      speakers: 'Speaker 0',
      hasCalendarTruth: true,
    })
    expect(out).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('does NOT append authoritative-source instruction when hasCalendarTruth is false', () => {
    const out = substitutePlaceholders(tmpl, {
      ...baseCtx,
      attendees: 'Speaker 0, Speaker 1',
      speakers: 'Speaker 0, Speaker 1',
      hasCalendarTruth: false,
    })
    expect(out).not.toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('regression: default templates reference {{attendees}}, not "Participants: {{speakers}}"', () => {
    for (const t of ['vc_pitch', 'founder_checkin', 'partners', 'lp', 'general'] as const) {
      const found = findTemplate(t)!
      expect(found.userPromptTemplate).toContain('Attendees: {{attendees}}')
      expect(found.userPromptTemplate).not.toContain('Participants: {{speakers}}')
    }
  })

  it('still appends user notes when template does not reference {{notes}}', () => {
    const out = substitutePlaceholders(tmpl, {
      ...baseCtx,
      notes: 'My private prep notes.',
      attendees: 'Sandy, Chris',
      speakers: 'Speaker 0',
      hasCalendarTruth: false,
    })
    expect(out).toContain('User Notes:\nMy private prep notes.')
  })

  it('shared instruction text matches desktop verbatim (T25 drift guard)', async () => {
    // Import the desktop counterpart and assert byte-identical text.
    // T25 (workspace package) will collapse these into one constant.
    const desktop = await import('../../packages/services/src/llm/templates')
    expect(AUTHORITATIVE_ATTENDEES_INSTRUCTION).toBe(
      desktop.AUTHORITATIVE_ATTENDEES_INSTRUCTION,
    )
  })
})
