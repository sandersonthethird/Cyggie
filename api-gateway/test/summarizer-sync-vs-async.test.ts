import { describe, expect, it } from 'vitest'

// =============================================================================
// summarizer-sync-vs-async.test.ts — desktop ⟷ gateway summarizer parity (T25).
//
//   desktop summarizer            gateway /meetings/:id/enhance
//   (services/llm/summarizer)     (routes/meetings.ts)
//          │                              │
//          └──────────┬───────────────────┘
//                     ▼
//            buildPrompt()  +  CANONICAL_MEETING_TEMPLATES   (@cyggie/shared)
//                     │
//          one function, one template source → identical prompts
//
// Before T25 the two surfaces hand-mirrored their prompt assembly
// (services buildPrompt vs gateway substitutePlaceholders) AND their template
// arrays, which silently drifted. They now share one implementation + one
// template source. This test locks that in three ways:
//   (1) referential identity — both import the SAME buildPrompt function;
//   (2) template-content parity — gateway TEMPLATES ⟷ desktop DEFAULT_TEMPLATES
//       byte-identical by id (guards a future re-introduced divergent copy);
//   (3) characterization — buildPrompt's attendee branches + grounding trailers.
// =============================================================================

import { buildPrompt as gatewayBuildPrompt, type PromptContext } from '@cyggie/shared'
import {
  AUTHORITATIVE_ATTENDEES_INSTRUCTION,
  ANTI_FABRICATION_INSTRUCTION,
} from '@cyggie/shared'
import { buildPrompt as desktopBuildPrompt } from '../../packages/services/src/llm/templates'
import { TEMPLATES, findTemplate } from '../src/templates/meeting-summary-templates'
import { DEFAULT_TEMPLATES } from '../../src/shared/constants/templates'

const tmpl = findTemplate('vc_pitch')!

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    transcript: 'Speaker 0: hello\nSpeaker 1: hi',
    meetingTitle: 'Birdwatch pitch',
    date: '5/26/2026',
    duration: '43 minutes',
    speakers: ['Speaker 0', 'Speaker 1'],
    ...overrides,
  }
}

describe('(1) assembly parity — single shared buildPrompt', () => {
  it('desktop and gateway import the identical buildPrompt function', () => {
    expect(gatewayBuildPrompt).toBe(desktopBuildPrompt)
  })

  it('same template + same context → byte-identical prompt', () => {
    const context = ctx({ attendees: ['Chris'], selfName: 'Sandy' })
    expect(gatewayBuildPrompt(tmpl, context)).toEqual(desktopBuildPrompt(tmpl, context))
  })
})

describe('(2) template-content parity — gateway ⟷ desktop seed', () => {
  it('the two sources expose the same template ids', () => {
    const gw = TEMPLATES.map((t) => t.id).sort()
    const desk = DEFAULT_TEMPLATES.map((t) => t.category).sort()
    expect(gw).toEqual(desk)
  })

  it('systemPrompt + userPromptTemplate are byte-identical for every id', () => {
    for (const desk of DEFAULT_TEMPLATES) {
      const gw = TEMPLATES.find((t) => t.id === desk.category)
      expect(gw, `gateway missing template ${desk.category}`).toBeDefined()
      expect(gw!.systemPrompt).toBe(desk.systemPrompt)
      expect(gw!.userPromptTemplate).toBe(desk.userPromptTemplate)
    }
  })
})

describe('(3) characterization — attendee branches + grounding', () => {
  it('null attendees → speakers fallback, NO authority claim', () => {
    const { userPrompt } = gatewayBuildPrompt(tmpl, ctx({ attendees: null }))
    expect(userPrompt).toContain('Attendees: Speaker 0, Speaker 1')
    expect(userPrompt).not.toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('attendees + selfName → owner prefixed + authority claim', () => {
    const { userPrompt } = gatewayBuildPrompt(
      tmpl,
      ctx({ attendees: ['Chris Rosenbaum'], selfName: 'Sandy Cass' }),
    )
    expect(userPrompt).toContain('Attendees: Sandy Cass (meeting owner), Chris Rosenbaum')
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('attendees=[] + selfName → just owner + authority claim', () => {
    const { userPrompt } = gatewayBuildPrompt(tmpl, ctx({ attendees: [], selfName: 'Sandy Cass' }))
    expect(userPrompt).toContain('Attendees: Sandy Cass (meeting owner)')
    expect(userPrompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  it('attendees has items + selfName=null → no fabricated owner', () => {
    const { userPrompt } = gatewayBuildPrompt(
      tmpl,
      ctx({ attendees: ['Chris Rosenbaum'], selfName: null }),
    )
    expect(userPrompt).toContain('Attendees: Chris Rosenbaum')
    expect(userPrompt).not.toContain('(meeting owner)')
  })

  it('anti-fabrication trailer is always present', () => {
    expect(gatewayBuildPrompt(tmpl, ctx({ attendees: null })).userPrompt).toContain(
      ANTI_FABRICATION_INSTRUCTION,
    )
    expect(gatewayBuildPrompt(tmpl, ctx({ companies: [] })).userPrompt).toContain(
      ANTI_FABRICATION_INSTRUCTION,
    )
  })

  it('user notes appended when the template does not reference {{notes}}', () => {
    const { userPrompt } = gatewayBuildPrompt(tmpl, ctx({ notes: 'My prep notes.' }))
    expect(userPrompt).toContain('User Notes:\nMy prep notes.')
  })

  it('userIdentity → owner line + task-attribution trailer', () => {
    const { userPrompt } = gatewayBuildPrompt(
      tmpl,
      ctx({
        userIdentity: {
          displayName: 'Sandy Cass',
          email: 'sandy@example.com',
          title: 'Partner',
          jobFunction: 'Investing',
        },
      }),
    )
    expect(userPrompt).toContain('Meeting Owner (you): Name: Sandy Cass')
    expect(userPrompt).toContain('Task Attribution Instructions')
  })
})
