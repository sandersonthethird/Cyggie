import { describe, expect, it } from 'vitest'
import {
  AUTHORITATIVE_ATTENDEES_INSTRUCTION,
  findTemplate,
  TEMPLATE_IDS,
} from '../src/templates/meeting-summary-templates'

// T25: substitutePlaceholders was deleted — the enhance route now builds
// prompts via buildPrompt from @cyggie/shared (same path as the desktop
// summarizer). Attendee-rendering / notes / authoritative-instruction
// behavior is now covered by:
//   • api-gateway/test/meetings-enhance-prompt.test.ts (route-level, buildPrompt)
//   • api-gateway/test/summarizer-sync-vs-async.test.ts (parity + characterization)
//   • src/tests/summary-prompt-instructions.test.ts (desktop buildPrompt)
// These tests guard the gateway template MODULE's public surface.

describe('meeting-summary-templates module', () => {
  it('exposes all 5 default template ids', () => {
    expect([...TEMPLATE_IDS].sort()).toEqual(
      ['founder_checkin', 'general', 'lp', 'partners', 'vc_pitch'].sort(),
    )
  })

  it('findTemplate resolves each id and returns the gateway shape', () => {
    for (const id of TEMPLATE_IDS) {
      const t = findTemplate(id)
      expect(t).toBeDefined()
      expect(t!.id).toBe(id)
      expect(typeof t!.systemPrompt).toBe('string')
      expect(typeof t!.userPromptTemplate).toBe('string')
    }
  })

  it('findTemplate returns undefined for an unknown id', () => {
    expect(findTemplate('not_a_template')).toBeUndefined()
  })

  it('default templates reference {{attendees}}, not legacy "Participants: {{speakers}}"', () => {
    for (const id of TEMPLATE_IDS) {
      const t = findTemplate(id)!
      expect(t.userPromptTemplate).toContain('Attendees: {{attendees}}')
      expect(t.userPromptTemplate).not.toContain('Participants: {{speakers}}')
    }
  })

  it('AUTHORITATIVE_ATTENDEES_INSTRUCTION matches desktop verbatim (shared source)', async () => {
    const desktop = await import('../../packages/services/src/llm/templates')
    expect(AUTHORITATIVE_ATTENDEES_INSTRUCTION).toBe(
      desktop.AUTHORITATIVE_ATTENDEES_INSTRUCTION,
    )
  })
})
