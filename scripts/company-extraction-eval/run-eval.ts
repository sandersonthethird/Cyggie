#!/usr/bin/env node
/* eslint-disable no-console */
//
// On-demand eval for the company-field LLM extraction prompt.
//
// Background:
//   The "Update fields from this meeting" modal used to surface hallucinated
//   round / post-money values pulled from comp-company mentions in pitch
//   summaries. The fix replaced regex extraction with an LLM call governed by
//   a strict system prompt that requires evidence-grounded extraction.
//
// What this script does:
//   Runs 3 fixture VC-pitch summaries through the same system + user prompt
//   that buildCompanyEnrichmentProposal() sends to the model in production,
//   then asserts that the parsed JSON does NOT hallucinate values for fields
//   the summary doesn't ground. Hits a real Anthropic model.
//
// Run:
//   ANTHROPIC_API_KEY=sk-... npx tsx scripts/company-extraction-eval/run-eval.ts
//   ANTHROPIC_API_KEY=sk-... npx tsx scripts/company-extraction-eval/run-eval.ts --model=claude-opus-4-7
//
// Exit code:
//   0 on all-pass, 1 on any failure.
//
// IMPORTANT — keep prompts in sync:
//   The SYSTEM_PROMPT and buildUserPrompt() below MUST mirror the strings in
//   packages/services/src/company-summary-sync.service.ts
//   (buildCompanyEnrichmentProposal). If you change the production prompt,
//   update this file too — otherwise the eval is testing a stale prompt.

import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

// Mirrors the systemPrompt assembled inside buildCompanyEnrichmentProposal.
const SYSTEM_PROMPT =
  'You are a company data extractor. Extract structured company information from ' +
  'the provided content. Return ONLY valid JSON — no prose, no markdown fences. ' +
  'For conflicting information, use the most recent value (content is in chronological order, last is most recent). ' +
  'Set fields to null if not mentioned in the content.\n\n' +
  'Return null unless the value is explicitly stated for the company being described. Specifically:\n' +
  '- round: only return the round currently being raised. Do not infer from comparable companies, prior rounds, or future plans. If the content describes a "seed" round, do not return "series_a" because a comp or competitor is at Series A.\n' +
  '- postMoneyValuation: only return a value if "post-money valuation" is explicitly stated for this company. Do not infer from market size, TAM, comparable company valuations, or pre-money figures.\n' +
  '- raiseSize: only return if the content explicitly states what this company is raising. Do not infer from comp deals or industry averages.\n\n' +
  'When in doubt, return null. False positives are worse than missing values.'

// Minimal pipeline-stage + industry lists so the user prompt matches
// production shape closely enough. Eval doesn't assert on these fields
// (the bug is round / post-money / raise size) so an exact-match isn't
// required.
const PIPELINE_STAGES = 'screen, diligence, decision, documentation, pass, portfolio'
const INDUSTRY_LIST = 'AI/ML, SaaS, Fintech, Healthcare, Consumer, Other'

function buildUserPrompt(companyName: string, summary: string): string {
  const fields = [
    '  "description": one-sentence company description (string or null)',
    '  "round": funding round, one of [pre_seed, seed, seed_extension, series_a, series_b] or null',
    '  "raiseSize": raise size in millions USD (number or null)',
    '  "postMoneyValuation": post-money valuation in millions USD (number or null)',
    '  "city": headquarters city (string or null)',
    '  "state": headquarters state abbreviation (string or null)',
    `  "pipelineStage": one of [${PIPELINE_STAGES}] or null`,
    `  "industry": one of [${INDUSTRY_LIST}] or null (must be exact string match; null if no good fit)`,
  ].join('\n')

  return (
    `Extract information about company: ${companyName}\n\n` +
    `Meeting summary:\n${summary}\n\n` +
    `Return a JSON object with these fields:\n{\n${fields}\n}`
  )
}

interface ExtractedCompany {
  description: string | null
  round: string | null
  raiseSize: number | null
  postMoneyValuation: number | null
  city: string | null
  state: string | null
  pipelineStage: string | null
  industry: string | null
}

function safeParse(text: string): ExtractedCompany | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed) as ExtractedCompany
  } catch {
    return null
  }
}

interface Fixture {
  name: string
  companyName: string
  summary: string
  assert: (extracted: ExtractedCompany) => string | null  // returns failure message or null
}

const FIXTURES: Fixture[] = [
  {
    name: 'comp-mention-trap (seed raise + Series A comp + comp $30M valuation)',
    companyName: 'Acme AI',
    summary: `## Executive Summary

Acme AI is building developer tooling for LLM evaluation. Founded by Sandy Cass.
The team is raising a $5M seed round to fund go-to-market.

## Market

Acme AI's main competitor is FooBar Inc, which recently closed a $20M Series A
at a $80M post-money valuation. Comparable AI tooling companies have generally
been valued at $30M+ at the seed stage according to public benchmarks.

## Recommendation

Move to diligence.`,
    assert: (e) => {
      const errs: string[] = []
      if (e.round === 'series_a') {
        errs.push(`round="series_a" — should be "seed" or null (Series A appears only in comp context)`)
      }
      if (e.postMoneyValuation !== null) {
        errs.push(`postMoneyValuation=${e.postMoneyValuation} — should be null (only comp valuations mentioned)`)
      }
      if (e.raiseSize !== null && Math.abs(e.raiseSize - 5) > 0.5) {
        errs.push(`raiseSize=${e.raiseSize} — expected ~5 (the actual raise) or null`)
      }
      return errs.length > 0 ? errs.join('; ') : null
    },
  },
  {
    name: 'market-size trap (TAM mentioned, no post-money)',
    companyName: 'Beta Health',
    summary: `## Executive Summary

Beta Health is a telehealth startup raising a $3M pre-seed round.

## Market

The total addressable market for telehealth is valued at $200B and growing.
The team estimates SAM at $20B.

## Team

CEO: Jane Smith.`,
    assert: (e) => {
      const errs: string[] = []
      if (e.postMoneyValuation !== null) {
        errs.push(`postMoneyValuation=${e.postMoneyValuation} — should be null (only TAM/SAM mentioned)`)
      }
      // Optionally check round
      if (e.round !== null && e.round !== 'pre_seed') {
        errs.push(`round="${e.round}" — expected "pre_seed" or null`)
      }
      return errs.length > 0 ? errs.join('; ') : null
    },
  },
  {
    name: 'happy path (explicit post-money stated for the company)',
    companyName: 'Gamma Robotics',
    summary: `## Executive Summary

Gamma Robotics builds warehouse automation robots. The company is raising a
$5M seed round at a $25M post-money valuation. Pre-money is $20M.

## Recommendation

Move to documentation.`,
    assert: (e) => {
      const errs: string[] = []
      if (e.round !== 'seed') {
        errs.push(`round="${e.round}" — expected "seed"`)
      }
      if (e.postMoneyValuation === null || Math.abs(e.postMoneyValuation - 25) > 0.5) {
        errs.push(`postMoneyValuation=${e.postMoneyValuation} — expected ~25`)
      }
      if (e.raiseSize === null || Math.abs(e.raiseSize - 5) > 0.5) {
        errs.push(`raiseSize=${e.raiseSize} — expected ~5`)
      }
      return errs.length > 0 ? errs.join('; ') : null
    },
  },
]

function parseArgs(argv: string[]): { model: string; help: boolean } {
  const out = { model: DEFAULT_MODEL, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length)
  }
  return out
}

async function callModel(client: Anthropic, model: string, userPrompt: string): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })
  // The Anthropic SDK returns an array of content blocks; we expect a single text block.
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  return text
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`
Company extraction prompt eval

Run:
  ANTHROPIC_API_KEY=sk-... npx tsx scripts/company-extraction-eval/run-eval.ts
  ANTHROPIC_API_KEY=sk-... npx tsx scripts/company-extraction-eval/run-eval.ts --model=claude-opus-4-7

Asserts the strict company-extraction prompt does NOT hallucinate round
or post-money values from comp/market mentions in 3 fixture VC pitches.
`)
    return
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] || process.env['CLAUDE_API_KEY']
  if (!apiKey) {
    console.error('ERROR: set ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in the env.')
    process.exit(2)
  }

  const client = new Anthropic({ apiKey })
  console.log(`Eval model: ${args.model}\n`)

  let passed = 0
  let failed = 0

  for (const fixture of FIXTURES) {
    const userPrompt = buildUserPrompt(fixture.companyName, fixture.summary)
    let raw: string
    try {
      raw = await callModel(client, args.model, userPrompt)
    } catch (err) {
      console.log(`✗ ${fixture.name}`)
      console.log(`   LLM call failed: ${(err as Error).message}\n`)
      failed += 1
      continue
    }

    const extracted = safeParse(raw)
    if (!extracted) {
      console.log(`✗ ${fixture.name}`)
      console.log(`   Could not parse model response as JSON.`)
      console.log(`   Raw response:\n${raw.split('\n').map(l => '     ' + l).join('\n')}\n`)
      failed += 1
      continue
    }

    const failure = fixture.assert(extracted)
    if (failure) {
      console.log(`✗ ${fixture.name}`)
      console.log(`   ${failure}`)
      console.log(`   Extracted: ${JSON.stringify(extracted)}\n`)
      failed += 1
    } else {
      console.log(`✓ ${fixture.name}`)
      console.log(`   Extracted: ${JSON.stringify(extracted)}\n`)
      passed += 1
    }
  }

  console.log(`\n${passed} passed, ${failed} failed (${FIXTURES.length} total)`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Eval crashed:', err)
  process.exit(2)
})
