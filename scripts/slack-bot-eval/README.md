# slack-bot-eval

Tool-selection regression suite for the Slack bot's `cyggieAsk` agent loop. Imports the exact system prompt and tool registry that production uses (from [`api-gateway/src/services/chat-agent/cyggie-ask.ts`](../../api-gateway/src/services/chat-agent/cyggie-ask.ts)) and exercises them against a real Anthropic model.

## What this eval checks

For each fixture question, the runner asserts the model's **first turn** response satisfies the fixture's expectations:

- `expectedRefusal: true` — the model refused (no tool calls; refusal pattern in the answer text). Used for prompt-injection probes and off-topic asks.
- `expectedToolsAnyOf: [...]` — the model called at least one of the named tools (e.g. `cyggie_get_company` OR `cyggie_search` both acceptable for a company lookup).
- `expectedToolArgsContain: { toolName: { fieldName: substring } }` — when a specific tool was called, its argument value contains the expected substring (case-insensitive).
- `expectedAnswerContains: [...]` — when no tool call was made, the answer text contains every listed substring (case-insensitive).

The eval does NOT execute the tools or chain multi-turn loops. Tool *selection* is the load-bearing regression to catch — if the model picks the wrong tool, the rest of the loop is wasted. Production multi-turn behavior is exercised by [`api-gateway/test/slack-ask-smoke.test.ts`](../../api-gateway/test/slack-ask-smoke.test.ts) with mocked tool results.

## Why it exists

Plan V1 follow-up TODO: "Eval suite for Slack bot answer quality. Build a fixture set of questions + expected behaviors (tool selection, answer fidelity, refusal cases). Regression-test on each PR to the agent service or system prompt."

Run it before merging any PR that touches:
- `api-gateway/src/services/chat-agent/cyggie-ask.ts` (system prompt, tool registry, caps)
- `api-gateway/src/services/chat-agent/system-prompts.ts`
- `api-gateway/src/mcp/server.ts` (any tool description that the in-process Slack handler also surfaces)
- The Anthropic model version pinned in `cyggie-ask.ts`

## Prerequisites

`ANTHROPIC_API_KEY=sk-...` in your env (or `.env.local` — the script loads it).

## Usage

```sh
pnpm eval:slack-bot
pnpm eval:slack-bot -- --model=claude-opus-4-7
pnpm eval:slack-bot -- --fixture=prompt-injection-system-extract
pnpm eval:slack-bot -- --verbose
```

Exits `0` if every fixture passes, `1` on any failure. Failures print a short diff (what the model picked vs. what was expected) and the raw model response.

## Fixture format

[`fixtures.json`](fixtures.json) is an array of:

```jsonc
{
  "name": "company-funding-direct",
  "question": "How much did Acme Inc raise?",
  // Pick ONE of the assertion modes. Refusal mode auto-implies no tool calls.
  "expectedToolsAnyOf": ["cyggie_get_company", "cyggie_search"],
  "expectedToolArgsContain": { "cyggie_get_company": { "name": "acme" } }
  // OR: "expectedRefusal": true, "expectedAnswerContains": ["CRM"]
}
```

## Adding fixtures

When a Slack-bot answer regresses in production (Sandy says "Cyggie kept calling get-contact when I asked about funding"), capture the question + the expected behavior here. Each fixture documents one regression class — they're cheap to keep and expensive to lose.

Names should be hyphenated and grouped by category (`company-*`, `contact-*`, `meeting-*`, `prompt-injection-*`, `off-topic-*`).

## Cost

Each fixture ≈ one Anthropic call with ~3K input tokens (system + tools + question) and ~150 output tokens. At Sonnet rates that's ~$0.01/run for the whole fixture set as it currently stands. Fine to run on every relevant PR.
