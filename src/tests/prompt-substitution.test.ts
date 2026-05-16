import { describe, it, expect } from 'vitest'
import { buildMemoProducerSystemPrompt } from '../main/llm/agents/memo-producer-agent'
import { buildThesisStressTestSystemPrompt } from '../main/llm/agents/thesis-stress-test-agent'
import { MEMO_SECTIONS } from '../main/llm/memo/sections'

describe('memo-producer system prompt substitution', () => {
  it('substitutes INVESTMENT_CRITERIA and SECTION_ROSTER and contains framework content', () => {
    const prompt = buildMemoProducerSystemPrompt([...MEMO_SECTIONS])
    expect(prompt).toContain('Founder (TEAM)')
    expect(prompt).toContain('Business model (AIM)')
    expect(prompt).toContain('Additional filters to apply')
    expect(prompt).not.toMatch(/###[A-Z_]+###/)
  })
})

describe('thesis-stress-test system prompt substitution', () => {
  it('substitutes STRESS_TEST_CHECKLIST and does not include criteria-file content', () => {
    const prompt = buildThesisStressTestSystemPrompt()
    // Checklist content present (phrases unique to the user-edited checklist).
    expect(prompt).toContain('Compounding Defensibility')
    expect(prompt).toContain('Per-section research budget')
    // Criteria content absent (was previously bundled; now removed).
    expect(prompt).not.toContain('Founder (TEAM)')
    expect(prompt).not.toContain('Business model (AIM)')
    expect(prompt).not.toContain('Additional filters to apply')
    // No placeholder leaked.
    expect(prompt).not.toMatch(/###[A-Z_]+###/)
  })
})
