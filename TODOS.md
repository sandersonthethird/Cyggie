# TODOS

## P1 — Mobile V1 (Phase 0–M7)

Tracker for the Cyggie Mobile V1 + cloud rearchitecture initiative.
Plan: `/Users/sandersoncass/.claude/plans/claude-code-prompt-jolly-eagle.md`.
Project memory: `~/.claude/projects/-Users-sandersoncass-Apps-Cyggie/memory/project_mobile_v1.md`.

### Mobile Chat — three-phase rollout

Plans: `~/.claude/plans/chat-on-mobile-needs-humble-crown.md` (Phase 1) + `~/.claude/plans/mobile-chat-phase-2-global-companies-picker.md` (Phase 2).

| # | Phase | Status | Notes |
|---|---|---|---|
| MC.1 | Mobile "New Chat" affordance (pencil icon on Ask Cyggie tab + kebab row on per-entity screens) + clear-on-session-swap + abort-in-flight | ✅ shipped | commits 866bf1d + 2c4e695. useStartNewChat hook + useClearOnSessionSwap hook + ChatComposer imperative `abortInflight` handle; 11 new tests across both hooks |
| MC.2 | Global Ask Cyggie: selectable company context | 🛠️ in flight | New `selected_company_ids jsonb` column on `chat_sessions` (both Postgres + SQLite mig 102); pill row + multi-select sheet; batched `buildSelectedCompaniesContext` helper (1 N+1 fix; exactly 2 queries regardless of selection size); 8 new gateway tests. RN component tests deferred per repo policy (see MC.runner below) |
| MC.3 | Company chat: gateway-side parsed_text for flagged files | ⏳ planned | Async parse-on-flag on desktop; sync via outbox (`company_flagged_files` not currently wrapped in `withSync` — Phase 3 fixes that); gateway extends `buildCompanyContextForChat` to pull parsed text from `company_flagged_files` |

### Mobile UI integration test runner (P2 infra)

**What:** Stand up @testing-library/react-native (or detox) as a separate
vitest project so React-Native component trees can be rendered and
asserted on. Today [vitest.config.ts:50-54](vitest.config.ts#L50-L54)
explicitly defers RN-UI tests to "a separate mobile-side runner that
knows how to mock the RN bridge."

**Why:** Phase 1 and Phase 2 plan-eng-reviews both flagged the gap; both
deferred. ChatComposer wiring, the global tab's pill row + picker
composition ([SelectedCompaniesPillRow](mobile/components/SelectedCompaniesPillRow.tsx),
[CompanyMultiSelectSheet](mobile/components/CompanyMultiSelectSheet.tsx)),
meeting screens, notes folder picker — none have integration coverage.
Phase 2 attempted a passthrough-mock approach in jsdom (mapping RN
View/Pressable/Text to HTML primitives) but it produced unstable test
queries; abandoned in favor of policy compliance.

**Pros:** Enables tests like "tap chip's × → updateChatSession PATCH
fires with the right body" that today are manual-smoke only.

**Cons:** Non-trivial setup (RN bridge mocking, native module shims,
CI config). Adds a second test runner alongside the existing root vitest.

**Context:** All current mobile tests live under `mobile/lib/__tests__/`
or `mobile/components/__tests__/` and run under jsdom for the latter
(per-file `// @vitest-environment jsdom`). RN UI tests can't reliably
use jsdom — they need a real React-Native renderer. Look at
@testing-library/react-native v12 + a metro-style transform.

**Depends on:** Nothing — can start immediately.

### Phase 0 status (cloud foundation)

| # | Phase | Status | Notes |
|---|---|---|---|
| 0.1 | npm workspaces conversion + 5 new package roots | ✅ shipped | commit 8e61f63 |
| 0.1.5 | electron-builder bundling | ✅ shipped | commit 8e61f63 |
| 0.2 | Postgres schema port (42 tables in Neon) | ✅ shipped | commit 8e61f63; see [packages/db/MIGRATION_AUDIT.md](packages/db/MIGRATION_AUDIT.md) |
| 0.3 | SQLite → Postgres data migration tool (14,033 rows) | ✅ shipped | commit 10ba0c3 |
| 0.4a | sqlite data layer → `@cyggie/db/sqlite/` | ✅ shipped | commit eec8104 |
| 0.5 batch 1 | LLM tree → `@cyggie/services/llm/` + ALS ProgressSink | ✅ shipped | commit 903eb3f |
| 0.5 batch 2 | 10 pure-Node services → `@cyggie/services/` | ✅ shipped | commit 903eb3f |
| 0.5 batch 3 | `RecordingSession` class + recording.ipc.ts refactor | ✅ shipped | commit 3201bf9 — 17/17 tests; gateway parity-test (`summarizer-sync-vs-async`) deferred to its own session (different code path, M3 timing) |
| 0.6 | Fastify gateway + OAuth + JWT + calendar route | ✅ shipped + deployed to Fly | commit 675e402 + Fly app `cyggie-gateway.fly.dev`. Sentry DSN still pending — Phase 2 observability decision deferred |
| 0.7 | this P1 TODOS section | ✅ shipped | this commit |

### Phase 0.5 Batch 3 — RecordingSession class ✅ shipped (commit 3201bf9)

All 16 module-level state vars from `src/main/ipc/recording.ipc.ts` (752 lines) extracted to [packages/services/src/recording/RecordingSession.ts](packages/services/src/recording/RecordingSession.ts) (~726 lines). The IPC handler shrank to 159 lines of Electron-specific wiring. 17/17 tests green: 4 in `recording-start.test.ts`, 6 in `recording-stop-defer.test.ts` (fixed 4 pre-existing barrel-mock breakages from commit 155a59a as a side-effect), 7 new in `recording-session.test.ts`.

**Deferred to a future session:**
- **`summarizer-sync-vs-async.test.ts`** — the plan called for this contract test proving desktop sync wrapper + gateway async path produce byte-equal output. Exercises a different code path (the LLM summary service that fires post-finalize), separate session.
- **Gateway-portable adapter interface** — class still imports `@main/...` for SQLite repos + deepgram + audio capture. When M3 needs gateway-side recording, introduce a `RecordingPersistenceAdapter` interface to swap the SQLite-bound implementation for a Postgres-backed one.

---

### Phase 0.5 Batch 3 — original planning (kept for archaeology)

**What:** Extract recording state from [src/main/ipc/recording.ipc.ts](src/main/ipc/recording.ipc.ts) (744 lines, 16 module-level vars) into a `RecordingSession` class consumed by both desktop and gateway. Add contract test `summarizer-sync-vs-async.test.ts` per plan §0.5.

**Why:** Module-level singletons in the desktop's recording handler can't go on the gateway (would break multi-user). The mobile recording flow (M3) needs the gateway to instantiate per-user sessions. Centralizing as a class lets both sides reuse the same lifecycle.

**Risk:** MEDIUM. RECORDING_START is 264 lines, RECORDING_STOP is 162 lines — both touch all 16 state vars. Acceptance includes a manual desktop UI smoke test (start recording → see partials within 500ms → stop → see summary within 10s).

**Steps:**
1. Write `packages/services/src/recording/RecordingSession.ts` (state vars become instance properties; methods for `start`, `stop`, `pause`, `resume`, `onAudioData`, `onSystemAudioStatus`).
2. Refactor `recording.ipc.ts` to hold one `RecordingSession | null` and delegate.
3. Replace `resetRecordingState()` with `session?.dispose()` + reassignment to `null`.
4. Write `progress-sink-propagation.test.ts` ✅ already shipped in 903eb3f.
5. Write `summarizer-sync-vs-async.test.ts` — verify desktop sync wrapper + gateway async path produce byte-equal output for a deterministic mocked LLM.
6. Run existing LLM eval suite as regression baseline; add 5 mobile-flow cases.
7. Manual smoke: start a real recording from the desktop UI, verify partials + summary.

**Depends on:** Phase 0.5 Batches 1+2 (✅ shipped).

**Effort:** L (4-6 hours focused work + smoke test).

**Priority:** P1 — blocks the mobile gateway's recording route (M3).

### Operational deliverables before Phase 0 close

Required before the first non-local gateway deploy:

| Item | Status | Notes |
|---|---|---|
| Real Google "Web application" OAuth client | ⏳ | Placeholder in `.env.local` — create at [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) |
| Fly.io deploy (api-gateway) | ⏳ | Needs `fly` CLI + Fly account; `fly launch` from `api-gateway/` |
| Sentry account + DSN | ⏳ | `SENTRY_DSN` env var slot already wired in [api-gateway/src/env.ts](api-gateway/src/env.ts) |
| Broader observability platform (Axiom / Honeycomb / Datadog / etc.) | 🔜 **Phase 2** | Sentry covers ~80% of V1 ops needs at single-firm scale. Layer a logs+traces platform when multi-firm growth or an oncall rotation justifies the cost. `DATADOG_API_KEY` slot in [env.ts](api-gateway/src/env.ts) left in place as an optional env var; populate when the platform is picked. |
| Cloudflare R2 bucket (private + signed URLs) | 🔜 **post-V1** | Originally planned for M4 canonical-WAV storage. Phone-side audio retention (mobile keeps the audio until `status='transcribed'` lands) removed the recording-durability driver — see [mobile/lib/recording/pending-upload.ts](mobile/lib/recording/pending-upload.ts) + [use-transcribing-poll.ts](mobile/lib/recording/use-transcribing-poll.ts). The real R2 driver becomes (a) re-transcribe ("re-process meeting X with model Y"), (b) "download original audio" UX, or (c) the post-V1 web client where the phone is no longer the canonical audio source. Revisit when the first concrete ask arrives. |
| APNs key + bundle ID | ⏳ | For push notifications in M2 |
| EAS Build subscription (Expo) | ⏳ | Required for M1a dev client builds |
| Apple Developer Program | ⏳ | Required for TestFlight + App Store in M6/M7 |

### Runbooks (skeletons committed; flesh out as features ship)

- [runbooks/oauth-mass-expiry.md](runbooks/oauth-mass-expiry.md) — what to do if all users hit reauth
- [runbooks/recording-stuck-finalize.md](runbooks/recording-stuck-finalize.md) — M3+ stall recovery
- [runbooks/sync-conflict-replay.md](runbooks/sync-conflict-replay.md) — Phase 1.5 conflict replay

### Day-1 observability (Sentry-only for V1)

V1 ships with **Sentry only**. Broader observability platform deferred to Phase 2.

- **Sentry Performance** auto-captures route p99 latency, error rate, slow-transaction details.
- **Sentry Issues** captures every `GatewayError` (as breadcrumbs) and every `INTERNAL_ERROR` (as captured exceptions with route + user_id + firm_id context).
- **Release tracking** — every Fly deploy tags releases so you can answer "did this release introduce new errors?"
- **`fly logs`** covers ad-hoc log search (last ~3 hours of structured pino output).

Metrics that would have been on Datadog are emitted as **structured pino log fields** (`metric=...`) so a Phase 2 platform can ingest them retroactively:

- `metric=routes.requests` (per route, per status)
- `metric=recording.sessions_active`
- `metric=recording.session_memory_bytes`
- `metric=sync.outbox_depth`
- `metric=sync.pull_connections_active`
- `metric=llm.cost_usd` (Anthropic spend per call, Deepgram minutes per call)
- `metric=oauth.refresh_result{result=success|failure}`

### Phase 2 observability decision (~M3+ or first scale signal)

When to revisit: multi-firm growth, multi-instance Fly deploy, formal oncall rotation, or repeated debugging sessions where Sentry's data isn't enough.

Contenders (decide alongside the M3 scale point):

| Platform | Strength | Rough $ |
|---|---|---|
| Axiom | Logs + traces, generous free tier (500 GB/mo) | $0 → $25/mo |
| Better Stack | Logs + uptime + heartbeats; small-team focused | $0 → $25/mo |
| Honeycomb | High-cardinality distributed tracing | $0 → $100/mo |
| Grafana Cloud | OSS-friendly, broad but steeper learning curve | $0 → $50/mo |
| Datadog | Best-in-class breadth + maturity | $50-100/mo+ |

Default Phase 2 recommendation: **Sentry + Axiom** (~$0-30/mo total).

### Mobile milestones (post-Phase 0)

| # | Milestone | Status | Estimate |
|---|---|---|---|
| M1a | Expo shell + OAuth round-trip + multi-tenant onboarding + Maestro/vitest infra + EAS dev profile | ✅ shipped | commits b7ec2ba / 52ec9d7 / 17ab09e |
| M1b | Calendar screen wired to `GET /calendar/events`; MMKV cache | ✅ shipped | commits b1a3273 / bc9e2c0 |
| M2 | Read-only CRM verticals (meeting, company, contact, notes, universal search) | ✅ shipped | commits 45bd145 / f571dd3 / 53a6f24 / 8143aff / e4bc492 |
| M2 | … + APNs push notifications | ⏳ pending | Slots in alongside M3/M4; needs APNs key + bundle ID provisioned |
| **M3** | **Recording happy path** (Opus encoder, WS protocol, Record FAB, live transcript, stage-1 finalize, fake-Deepgram tests) | ⏳ **next** | 3 weeks — Phase 0.5 Batch 3 (`RecordingSession` class) just shipped; M3 is unblocked |
| M4 | Recording resilience (gap reconstruction, Live Activity, stage-2 finalize, 8hr cap) | ⏳ pending | 2.5 weeks; needs Cloudflare R2 bucket for canonical WAV |
| M5 | AI Chat (SSE + citations), Tiptap notes editor + Enhance, writes | ⏳ pending | 2 weeks |
| M6 | Polish, empty states, settings, TestFlight cohort 1, 10 Maestro E2E flows green | ⏳ pending | 2 weeks; needs Apple Developer Program seat |
| M7 | App Store prep, cutover sequence, feature flags, user docs | ⏳ pending | 1.5 weeks |
| Phase 1.5a | Desktop → Neon one-way sync (writeWithSync barrel, SyncAgent, /sync/push, drizzle-zod validators, dead-letter) | ✅ shipped | commits 7066796 / 99e1c38 / 36ff7f3 / 1778f7e — 59/59 + 17/17 tests, deployed to Fly. Desktop OAuth now wired so the SyncAgent has a real JWT. |
| Phase 1.5b | Mobile → Neon writes (PATCH routes, mobile-side outbox, GET /sync/pull) | ⏳ pending | Ships when M4–M5 add mobile-side editing flows |
| Phase 1.5c | Real-time push (SSE + APNs, sub-second propagation) | ⏳ pending | Ships when polling-refetch latency hurts |

### Mobile meeting list filter parity for past `'scheduled'` rows

**What:** Audit the Expo client's meeting list filter (`mobile/`) to ensure past `'scheduled'` and past `'error'` rows render in the Past view, matching the desktop behaviour shipped via the "i had a meeting" fix.

**Why:** Desktop now seeds a `'scheduled'` row whenever the meeting notifier fires for a calendar event (and a reconcile loop creates rows for past events the notifier missed). These rows propagate to Neon via the outbox → mobile via M2 sync. If the mobile filter still mirrors the *old* desktop filter (status whitelist of `'recording'/'transcribed'/'summarized'`), the user will hit the same disappearing-meeting bug on phone.

**Context:** The desktop filter relax + helper extraction landed alongside this TODO. See plan `/Users/sandersoncass/.claude/plans/i-had-a-meeting-adaptive-seal.md`. The meeting-status state machine + visibility rules are now documented inline at [src/shared/types/meeting.ts](src/shared/types/meeting.ts) above the `MeetingStatus` union.

**Depends on:** M2 meeting list has shipped already (commits 45bd145 / f571dd3) — this is a post-ship audit. Should land before M3 starts adding write paths to the same screens, since M3 will compound any filter mismatch.

**Effort:** S (audit + likely a one-line filter change + 1-2 tests).

**Priority:** P2 — bug is user-facing but only triggers once the user has both desktop and mobile installed and dismisses a notification on desktop.

### Cloud-side Gmail + Drive services (post-V1 — Model A backlog)

**What:** Migrate Gmail ingestion + Drive read/write capability to `packages/services/google/` so the gateway can read user emails and write user Drive files server-side. Adds gateway routes for triggering ingest + on-demand fetch. Implements behind a `GoogleApiClient` interface so Model B (desktop-mediated proxy) stays swappable.

**Why:** V1 desktop already does this locally; mobile reads the synced result from Neon via the Phase 1.5 sync agent. Cloud-side becomes necessary when:
- A customer firm onboards without desktop installed (mobile-only / web-only partners), OR
- Mobile chat queries demand richer email-thread retrieval than the synced cache provides, OR
- The Phase 2 web client launches and needs to render Gmail/Drive content live.

**What's in scope when this work lands:**
- Port `company-email-ingest.service.ts` patterns to packages/services with an ALS `ProgressSink` shim (same approach as Phase 0.5 Batch 1).
- Port Drive read/write helpers from desktop to packages/services.
- Gateway routes: `POST /ingest/email/start`, `GET /ingest/email/status`, `POST /drive/files`, `GET /drive/files/:id`.
- Per-firm quotas + audit log entries on every Google API call.
- `GoogleApiClient` interface in packages/services/google/ with one implementation today (direct API call from gateway); Model B implementation (queue-to-desktop) stays unimplemented.
- Mobile UX: surface "Ingesting your inbox…" progress when first sign-in triggers backfill.

**Why deferred from Phase 0:**
Per user direction 2026-05-18 — ship basic mobile (calendar + recording + chat over already-synced data) first. Once V1 is in real customers' hands, the actual drivers for cloud Gmail/Drive (no-desktop partners, query depth, web client) will surface concretely and inform the design. Avoids speculative architecture before product-market signal.

**OAuth scope implications (open question):** Until this work lands, the gateway's V1 actual use of Gmail/Drive is zero. Two options for the V1 consent screen:
- **Keep current broad consent** (Gmail + Drive + Calendar via `include_granted_scopes: true`): no future re-consent needed when this work ships; first-time customers see scopes that don't match V1 use.
- **Narrow V1 to Calendar only** (`include_granted_scopes: false`): clean V1 consent UX; need an incremental-authorization prompt UX when this work eventually ships.
Recommendation: narrow to Calendar for V1 cleanliness; build the incremental-auth prompt as part of this backlog item.

**Effort:** ~2 weeks once prioritized.

**Priority:** P1 — gates the "true cloud-only customer" segment.

**Depends on:** V1 mobile shipped + Phase 1.5 sync agent operational + first-customer signal on whether cloud Gmail/Drive is actually needed.

---

### MIGRATION_AUDIT checklist (Phase 0.2 leftover)

The full per-migration audit is in [packages/db/MIGRATION_AUDIT.md](packages/db/MIGRATION_AUDIT.md). 69 of 95 source SQLite migrations are covered by the consolidated drizzle schema. Remaining 26 are either inline-during-port, skip-superseded, or repair-scripts deferred to a `data-quality-passes.ts` script not yet written.

### M3 follow-ups (deferred from multi-slot pendingUpload PR)

| Item | Why | Pointer |
|---|---|---|
| Cancellable uploads via AbortController | Today's `uploadRecording` uses `expo-file-system/legacy.createUploadTask` which has no AbortSignal. The cold-start `'uploading'` branch in [mount-action.ts](mobile/lib/recording/mount-action.ts) early-returns as "preserve" because we can't interrupt a fetch-in-progress without orphaning the file. Uploads are <5s in practice so this is currently dead code — but if upload latency grows or we want explicit-cancel UX, AbortController is the prerequisite. | [mobile/lib/api/recordings.ts](mobile/lib/api/recordings.ts) `uploadRecording` |
| Recordings discoverability surface | The calendar list shows Google Calendar events (`fetchCalendarEvents`), not recording meetings. If a user records 3 impromptu meetings and navigates away, there's no UI today that lists them — only direct nav to `/meetings/[id]`. Background-recording status pills make sense once such a surface exists; this PR added the StatusPill component + tested mapping for that future use. Options: (a) "Recordings" tab, (b) "Recent recordings" section in calendar list, (c) include recording rows in search. | Plan: extend gateway with `GET /meetings?filter=recent`, then mount a list view on mobile |

### Required tests still owed (from eng review)

| Test | Milestone | Path | Status |
|---|---|---|---|
| `progress-sink-propagation.test.ts` (ALS context survives SDK + nested calls) | Phase 0.5 | [src/tests/progress-sink-propagation.test.ts](src/tests/progress-sink-propagation.test.ts) | ✅ 8/8 pass |
| `summarizer-sync-vs-async.test.ts` | Phase 0.5 Batch 3 | TBD | ⏳ |
| Fake-Deepgram subprocess | Phase 0.6 follow-up | `api-gateway/test/fake-deepgram/` | ⏳ |
| Opus encoder round-trip | M3 | `mobile/lib/recording/opus.test.ts` | ⏳ |
| WS frame envelope (seq monotonic, dedup, gap detection) | M3 | `api-gateway/recording/wire.test.ts` | ⏳ |
| Two-stage finalize merge | M3 + M4 | `api-gateway/recording/finalize.test.ts` | ⏳ |
| Gap chunks → prerecorded → assembler merge | M4 | `api-gateway/recording/assembler.test.ts` | ⏳ |
| Quota soft-warn / hard-cut thresholds | M3 | `api-gateway/quota.test.ts` | ⏳ |
| OAuth re-consent flow (simulate `invalid_grant`) | M1a | `api-gateway/auth/reauth.test.ts` | ⏳ |
| LLM eval suite regression + 5 new mobile-flow cases | Phase 0.5 Batch 3 | existing eval scripts | ⏳ |
| Lamport row-clock + sync-time field diff | Phase 1.5 | `packages/services/sync/diff.test.ts` | ⏳ |
| Sync agent state machine | Phase 1.5 | `packages/services/sync/agent.test.ts` | ⏳ |
| Soak test: bidirectional sync 7-day accelerated | Phase 1.5 | `packages/services/sync/soak.test.ts` | ⏳ |

---

### M5-thin follow-ups (deferred from the pre-build M5-thin slice)

The M5-thin slice (commit TBD on `main`, 2026-05-22) shipped a working
Chat tab + Notes Enhance button against new gateway routes `POST /chat/messages`
and `POST /chat/enhance-notes`. Both are stateless one-shots — no
persistence, no streaming, no citations, no Tiptap rewrite. These items
fill out full M5 in subsequent passes.

| # | What | Why | Effort | Notes |
|---|---|---|---|---|
| **T17** | **Chat session persistence + Neon sync** | Mobile Chat tab forgets every conversation on tab unmount. Desktop has `chat_sessions` + `chat_session_messages` tables (migrations 078-080) but they're SQLite-local — never written to Neon. To make mobile chat persist AND sync to desktop, mirror those tables in Neon, add `GET /chat/sessions`, `POST /chat/sessions`, `GET /chat/sessions/:id/messages`, then route desktop writes through the Phase 1.5a outbox the same way `meetings` flow does. **PRIORITY:** promoted from P2 → **P1** on 2026-05-23 (plan-ceo-review REDUCTION pass) — multiplayer-by-default in V1 means chat history must survive across teammates and devices. | L (~3-5 days) | Reuses `withSync` wrapper + applyRemote primitive from Phase 1.5a/c. T14 covers the multi-table pull side. |
| **T18** | **SSE streaming for /chat/messages** | Today the route awaits the full Claude response (often 8-15s for long replies) before returning anything. UX would be much better with token-by-token streaming. Anthropic SDK supports `client.messages.stream()`; Fastify handles SSE via `reply.raw.write()`. | M (~2 days) | Mobile-side: `EventSource`-style consumer via `expo-fetch` or a polyfill (RN doesn't have `EventSource` natively). Test against a mocked SSE producer to keep Claude out of CI. |
| **T19** | **Multi-turn chat (history sent with each message)** | The current route is one-shot — every message is a fresh conversation. Users will expect "as we just discussed…" follow-ups. Cheapest path: client sends `messages: [{role,content}…]` array, gateway forwards as-is to Anthropic. Needs context-budget management (truncate oldest user turns when total exceeds ~50KB). | S (~half day) | Depends on T17 only if we want history to survive app kill. Without T17, history lives in `useState`. |
| **T20** | **Citations into transcript ranges** | When the chat reply references a meeting, link `[1]` `[2]` style citations back to specific transcript segments. Tap a citation in mobile → scrolls to that point in the meeting detail's transcript view. | L (~3 days) | Requires the chat prompt to ask for structured `<cite seg="…">` blocks + a parse step on the gateway. Mobile UI changes are small once the data shape lands. |
| **T21** | **Tiptap notes editor (replace plain TextInput on meeting detail)** | Plain TextInput works but is single-style and clunky for multi-paragraph notes. Tiptap (via `@tiptap/react-native` or equivalent) gets us bullets, headings, links. Desktop already uses Tiptap — porting brings parity. | L (~4-5 days) | Notes Enhance still works through Tiptap (replace the editor content via the doc API). |
| **T22** | **"Diff modal" for Enhance** | Today's Enhance is silent-replace (with a confirm dialog). Better UX: show before/after side-by-side, let user accept/reject hunks. | M (~2 days) | Use existing `diff` package (already a mobile dep). Mobile diff UI patterns from MeetingDetail conflict modal. |
| **T23** | **Test coverage for new chat routes** | `POST /chat/messages` and `POST /chat/enhance-notes` ship without tests because external-API routes were skipped (Anthropic SDK call). Cleanest path: a tiny `FakeAnthropic` mock in `api-gateway/test/_helpers/` + 4-5 happy/error cases per route. | M (~1 day) | Matches the fake-Deepgram pattern already in TODOS (Phase 0.6 follow-up). |
| **T24** | **BYO-key — per-user Anthropic key on the gateway** | M5-thin shipped with the gateway reading `env.ANTHROPIC_API_KEY` directly on every chat request. That works for a single-firm beta (one firm = the developer's key) but is wrong the moment external users land — they would all unknowingly bill against the gateway-owner's Anthropic account, eat into one shared rate limit, and have no way to set their own key. The existing memory note about Deepgram keys ("Desktop app stores a per-user key in SQLite; gateway needs a separate gateway-owned key in env. Don't conflate.") covers a *different* axis (per-user vs gateway-owned for ingestion) and does not solve this. The Anthropic key needs a *third* tier: per-user-overridable. **Sketch:** add `user_settings.anthropic_api_key` column (encrypted at rest via pgcrypto or app-level encryption); gateway resolves the key in priority order `user_settings.anthropic_api_key → env.ANTHROPIC_API_KEY → 503`. Desktop Settings already has a "Claude API Key" input (`getCredential('claudeApiKey')`) — extend the existing settings sync path (Phase 1.5a outbox already handles `user_settings.*`) so a desktop paste propagates to Neon, which the gateway then reads on each chat request. Mobile gets a matching field in the Settings screen shipped in da5f34a. **Until T24 ships, the gateway is single-tenant for AI features** — do not onboard a second firm before this lands. **STATUS:** ✅ shipped via commits 6e2c63a + 742bb69. user_credentials table holds per-user key; gateway resolves via resolveAnthropicKey helper; desktop pushes via pushAnthropicKey on Settings save + on startup. | L (~2-3 days) | Depends on Phase 1.5a user_settings sync path (already wired for other settings). Same encryption pattern likely applies to OpenAI / Ollama keys when those providers come back online server-side. |
| **T32** | **BYO-key — Deepgram (extend `user_credentials`; delete gateway env var)** | Mirror T24 for Deepgram. Today: desktop uses per-user key from SQLite for live-stream; gateway uses its own `DEEPGRAM_API_KEY` env var for mobile-uploaded batch transcription — same multi-firm trap T24 was solving for Anthropic. **Sequencing (decided 2026-05-23, plan-ceo-review Issue 1A):** (1) extend `user_credentials` provider enum to `'deepgram'`, (2) extend `resolveProviderKey` to handle deepgram, (3) extend desktop push path so the existing `deepgramApiKey` in SQLite settings propagates to `user_credentials` on Settings save + on startup, (4) extend mobile Settings UI with a Deepgram key field that calls the same endpoint, (5) verify Sandy's Deepgram row exists in Neon, then (6) **delete `DEEPGRAM_API_KEY` from Fly secrets** (`flyctl secrets unset DEEPGRAM_API_KEY`) — hard cutover, no fallback. Adds a Sentry alert for "Deepgram 401 from gateway" so a missing key row surfaces immediately. **Gates safe multi-firm onboarding.** **STATUS:** ✅ shipped — PR-A (resolver + desktop push paths, env fallback retained) in commit afc4d1d; PR-B (drop env fallback, env.ts optional, Sentry 401 alert) in commit ff4ed74. Sandy's `(provider='deepgram', length=40)` row verified in Neon 2026-05-23 13:14:02 UTC. Final manual step pending: `flyctl secrets unset DEEPGRAM_API_KEY`. Mobile Settings UI for Deepgram deferred — desktop push is sufficient for V1 (Sandy is on desktop). | M (~1 week) | **P1.** Reuse T24's resolveProviderKey pattern verbatim. Deepgram billing collapses to one per-user account (the user pays for both desktop live-stream and gateway batch). Acceptable at single-firm beta scale; revisit if multi-firm onboarding ever wants Cyggie-pays-for-trial transcription. |
| **T33** | **BYO-key — remaining providers (OpenAI, Exa, WebShare)** | Same pattern as T24/T32 for the three remaining gateway-relevant providers. **Memo deliberately excluded** (decided 2026-05-23) — memo-writing stays desktop-only for the foreseeable future, so the gateway never calls a memo API. None of these are wired to gateway routes today (so unlike Deepgram, no env-var-deletion sequencing risk), but they need to be plumbed for parity before any non-Anthropic gateway route ships (specifically T3 enrichment relocation, which is the only consumer that benefits). Mechanical: extend `ALLOWED_PROVIDERS` enum + DB CHECK constraint + `resolveProviderKeyFromDb` union + `PushableProvider` union + 3 SETTINGS_SET hooks. Bundle as one PR. | S (~3 hours total) | P3. Becomes P1 the moment T3 (or another gateway route for OpenAI/Exa/WebShare) is scheduled. |
| **T34** | **Markdown styles to a shared mobile file** | Today `summaryMarkdownStyles` lives in `mobile/app/meetings/[id].tsx` (~line 1459) and a verbatim copy `memoMarkdownStyles` lives in `mobile/app/companies/[cid]/memos/[mid].tsx`. Two consumers is the "wait for a third before extracting" line per the engineering preferences. Extract to `mobile/lib/markdown-styles.ts` when a third surface (chat responses with markdown? rich note rendering?) lands. | S (~1 hour) | P3. Trigger: third markdown-rendering surface. |
| **T35** | **Horizontally scrollable SegmentControl** | Company detail now has 5 tabs (Overview / Meetings / Memos / Notes / People). On iPhone SE (320pt) this is at the edge of what fits without truncation. Today's `SegmentControl` in `mobile/app/companies/[id].tsx` (~line 205) is a flat `<View>` with equal-width children; no horizontal overflow handling. **Fix:** wrap in `<ScrollView horizontal>` with `showsHorizontalScrollIndicator={false}` and `contentContainerStyle` for centered alignment when width permits. Apply same fix to meeting detail's segment control (4 tabs today; could grow). | M (~half day) | P3. Trigger: a user reports cramped UI on iPhone SE OR detail screens routinely add a 6th tab. |
| **T36** | **Memo version history viewer on mobile** | Today mobile shows only the latest version's contentMarkdown. Desktop's memo editor lets users view/restore prior versions via `investment_memo_versions` table. Mobile equivalent: add a version-switcher pill in the memo-detail topbar that opens a list of versions ordered by `versionNumber DESC` with `change_note` previews. Tap a version → re-fetch `GET /memos/:id?version=N` (new query param on the existing route) → swap the markdown body. | M (~1 day) | P3. Defer until a user asks; the typical mobile workflow is "skim the latest" not "compare versions". |
| **T37** | **Memo evidence drill-in on mobile** | `memo_evidence` table (migrations 085 + 090) links each memo claim to source meetings / transcripts / web URLs. On desktop, clicking a claim jumps to the source. Mobile equivalent: when rendering memo markdown, inject inline tappable links for claims that have evidence rows; tap → push to `/meetings/:id` with a scroll target at the right transcript range (or web URL via Linking.openURL). Significantly enhances the read view's value as a "verify a claim while skimming on the go" tool. Requires extending `GET /memos/:id` response to include evidence joins, OR a separate `GET /memos/:id/evidence` endpoint. Inline-link injection on the mobile side requires parsing the markdown to identify claim sentences — non-trivial. | M-L (~2-3 days) | P3. Trigger: user signal that they want this on mobile (it might stay primarily a desktop drafting workflow). |
| **T38** | **SyncAgent adaptive batching + outbox payload trimming** | T17a A1 verification surfaced a real issue 2026-05-23: gateway returned `FST_ERR_CTP_BODY_TOO_LARGE` (413) on `/sync/push` when desktop's 200-row batch included meeting rows with large `transcript_segments` JSONB plus newly-added chat_session_messages. Bandaid landed in commit TBD: bumped gateway `bodyLimit` 10 MB → 50 MB. Real fix has two parts. **(a) Adaptive batching in `src/main/services/sync-agent.ts`:** on 413, halve the batch size and retry; persist the discovered safe-batch ceiling in `sync_state` so subsequent ticks start at the right size. **(b) Outbox payload trimming in `_sync.ts` / `withSync()`:** for UPDATE ops, emit only the columns that actually changed (or at minimum exclude large-JSONB columns the caller didn't touch). Today every outbox UPDATE emits the entire row including unmodified large fields. Both fixes together let the gateway keep a sane body limit and stop the cascade where one big meeting blocks the whole queue. | M (~2-3 days for both) | **P2.** 50 MB bandaid is fine for single-firm beta; revisit before multi-firm onboarding — a hot meeting with many transcript updates could still overflow under concurrent edits. |
| **T25** | **Shared templates workspace package.** | Templates for meeting summarization live in `src/shared/constants/templates.ts` (desktop import path) AND mirrored in `api-gateway/src/templates/meeting-summary-templates.ts` (copy with `category` renamed to `id`). Two sources of truth that must be kept in sync by hand when a template is added/changed. Mobile picker fetches via `GET /templates` so it inherits the gateway copy — only the gateway + desktop need re-syncing. **Fix:** create a workspace package (`packages/shared/src/constants/templates.ts` or extend `@cyggie/db`) and have desktop + gateway both import from it. Mobile keeps the fetch posture. | M (~half day) | Effort low; priority lifts to P2 once a real divergence happens. | P2 |
| **T26** | **SSE streaming for /meetings/:id/enhance.** | Today the route blocks the mobile UI for 5-15s while Claude generates. Token-by-token streaming would massively improve perceived latency. Anthropic SDK supports `client.messages.stream()`; Fastify exposes raw `reply.raw.write()` for SSE. Mobile needs an EventSource consumer (RN doesn't ship one — use `event-source-polyfill` or roll a tiny one via `expo-fetch`). Test against a mocked SSE producer to keep Claude out of CI. | L (~2 days) | Pair with T18 (same pattern on /chat/messages) for one combined SSE landing. | P3 |
| **T27** | ~~Markdown rendering on mobile~~ | **OBSOLETE.** Shipped in commit 00fa047 via Item 2 — `react-native-markdown-display` is installed and rendered in SummarySection. | — | — |
| **T28** | **User-editable templates on mobile.** | Today mobile picker shows the 5 hardcoded templates. Desktop will eventually let users create/edit templates (template seed/editor surface). Mobile mirrors via the existing `GET /templates`. Requires: gateway stores user templates in a new `templates` table (or extends settings), mobile UI for create/edit, picker shows user templates above defaults. | L (~3-4 days) | Depends on T25 (shared source for default templates). | P3 |
| **T29** | **Template-picker UX polish.** | Add "last used" memory (persist last-picked template id per meeting), preview of the system prompt before commit, drag-to-reorder, search/filter. Today's picker is a vanilla list. | S | Defer until 1+ user complains. | P3 |
| **T30** | **Rate-limit middleware on /meetings/:id/enhance + /chat/messages.** | Each call costs $0.01-0.05 in Anthropic spend. A bug or malicious client could spam the endpoint and burn the user's monthly cap. Single-user beta means you can only spam yourself, so V1 acceptable — but the moment multi-tenant onboarding lands (or a buggy client ships) this becomes a real cost-burn vector. **Sketch:** `@fastify/rate-limit` plugin with per-user keying via JWT.sub. Suggested limit: 10 enhance/min/user, 60 chat/min/user. Returns 429 with retry-after header. Mobile + desktop both surface the 429 message verbatim. | M (~half day) | Trigger: multi-tenant onboarding OR observed abuse signal. | P3 |
| **T31** | **Token usage monitor in mobile Settings.** | After T-NEW token telemetry on Enhance + chat (shipped with the Enhance plan), per-user spend lives in pino logs as `metric=meetings.enhance.complete inputTokens=X outputTokens=Y`. Aggregate into a queryable endpoint `GET /usage?window=30d` and surface in mobile Settings as a "This month: $X.XX spent on AI" row. Foundation for cost transparency before external users land. **Sketch:** lightweight rollup table written by a post-handler hook (or aggregate the logs at query time via Sentry/Axiom if T15 lands first). | M-L (~1-2 days for server-side aggregation; few hours for the mobile UI on top) | Depends on Phase 2 observability platform decision (logs vs SQL rollup). | P2 |

---

## P2 — Sync (Phase 1.5a follow-ups)

Captured during the 1.5a ship. None block the existing shipped slice but
should land before Phase 1.5b expands the surface.

### Desktop OAuth flow + getAccessTokenForSync wiring ✅ shipped
Sign-in window on the desktop wired to the gateway's OAuth flow via custom
`cyggie-desktop://` URL scheme. `cyggie-auth.ts` + `cyggie-auth-storage.ts`
(safeStorage-backed) + IPC handlers + Settings UX integrated into the
"Available Connections" panel as a peer of Calendar/Gmail/Drive. SyncAgent's
`getAccessToken()` reads the live token; on 401 it refreshes (single-flight)
and retries, signs out on second 401. Ships:
- commit 73e14cd — desktop OAuth → Cyggie JWT for SyncAgent
- commit edb0715 — surface verified email in OAuth deep-link callback
- commit 40856cd — move Cloud Sync into Available Connections panel
- commit e9ba804 — gateway: desktop handoff page + OAUTH_STATE_INVALID observability
- commit 9131116 — fix(credentials): wipe legacy-encrypted AI API keys in dev (v2 migration)

### `scripts/sync-replay.ts` — dead-letter recovery tool ✅ shipped
At [scripts/sync-replay.ts](scripts/sync-replay.ts). Subcommands:
- `dump` — counts by status + sync_state + 20 most-recent failed/dead rows
- `replay-dead [--limit N]` / `replay-failed [--limit N]` — flip target rows
  back to status='pending', reset attempts + last_error. SyncAgent's next 5s
  drain picks them up.
- `wipe-dead` — DELETE all status='dead' rows
- `wipe-all --confirm` — DELETE every outbox row (destructive; needs explicit flag)
- `delete <id>` — DELETE one row by primary key

ABI: better-sqlite3 is rebuilt for Electron's ABI by postinstall; running
the script with tsx requires `npm rebuild better-sqlite3` first, then
`npx @electron/rebuild -f -w better-sqlite3 --buildFromSource` after.
Docstring on the script reminds you.

### Sync metrics dashboard
**What:** Grafana board (or Sentry widget) covering `sync.outbox_depth`,
`sync.push_failures`, `sync.dead_letters`, `sync.conflicts_total`,
`sync.drift_detected`, `sync.bypass_detected`.
**Why:** Captured by the plan review. The metrics already emit; this just
visualizes them.
**Depends on:** Phase 1.5b or first multi-device user (until then a single
user, single device — grep is fine).

### Cascade-aware outbox emission for multi-table writes
**What:** The barrel's `withSync` wrapper currently only emits the PRIMARY
entity row. Multi-table side effects in the wrapped repos (e.g.
`createMeeting` writing `meeting_company_links` via
`syncMeetingCompanyLinks`; `mergeContacts` rewiring emails+links;
`renameFolder` updating many notes' folder_path) stay unemitted.
**Why:** Documented gap in the barrel header. Mobile views refetch on
focus so the gap closes when the parent row is next touched, but for
edit-heavy moments the link tables go stale briefly.
**How:** Either (a) modify the inner repo functions to call
`appendOutboxRow(db, …)` for each child row, or (b) add a snapshot-diff
mechanism that reads pre/post row counts on owned tables inside the
transaction.
**Depends on:** Nothing.

### Wrap the other 4 owned-table repos
**What:** Extend the barrel to wrap task / template / pipeline-config /
chat-session repos. Tables: tasks, templates, themes (no repo), speakers
(no repo), pipeline_configs, pipeline_stages, chat_sessions,
chat_session_messages.
**Why:** Mobile doesn't read these in M2/M3, so they're deferred from
1.5a. As M4–M5 add tasks/chat surfaces, the underlying tables need to
sync too.
**Depends on:** Mobile M4 (tasks UI) and M5 (AI chat UI) decisions on
which entities mobile actually reads.

### Replace direct Neon ALTER TABLE with a proper drizzle migration ✅ shipped
Already covered by migration `0010_sturdy_red_shift.sql`, which contains
the 6 `ADD COLUMN lamport` statements for the join tables (org_company_aliases,
contact_emails, meeting_company_links, meeting_speaker_contact_links,
meeting_speakers, chat_session_messages). A fresh `pnpm db:migrate` against
an empty Postgres applies them correctly. TODO predates the migration getting
generated; closing as no-op.

### Remove temporary console.log from notes.repo.deleteFolder
**What:** Drop the unguarded `console.log` in
[deleteFolder](packages/db/src/sqlite/repositories/notes.repo.ts) once the
user has reproduced the original "Skills folder still there" bug with the
log present and confirmed the fix.
**Why:** No other repo logs unconditionally in production; this one is
intentionally temporary for triage and will rot in place without a
tracked TODO.
**Pros:** Removes debt before it accumulates.
**Cons:** Trivial; single line removal.
**Context:** Plan file
`/Users/sandersoncass/.claude/plans/1-folder-delete-doesn-t-fluffy-boot.md`
(review decision 2B). The log line was added alongside the sync-wrap of
`deleteFolder` to capture row counts in the main-process terminal while
the original repro was outstanding.
**Effort:** S
**Priority:** P3
**Depends on:** User confirms the diagnostic surfaced the root cause and
the delete works after the fix.

---

## P1 — Sync (Phase 1.5b follow-ups, post-mobile-tap-to-view PR)

These 8 items were captured during the plan-ceo and plan-eng reviews of
the mobile calendar-tap-to-view + notes-editing PR. Stage 1 of that PR
shipped the gateway + migration + tests; the remaining mobile work and
these TODOs follow.

### T1 — `/sync/pull` pagination
**What:** Add `limit` + `cursor` to `GET /sync/pull`. The endpoint
returns all user-scoped meetings with `lamport > since` ordered by
lamport ASC; for first-launch (since=0) on a heavy account this could
return hundreds of rows in one shot.
**Why:** Plan-ceo-review 11B accepted unbounded responses for V1's
single-firm scale. Hard cliff at ~500 meetings/user.
**Pros:** Bounded latency + memory at the gateway and on mobile.
**Cons:** Adds a stateful cursor on both sides; ~half a day of work.
**Context:** [api-gateway/src/routes/sync.ts](api-gateway/src/routes/sync.ts) — current handler returns full result set with `serverLamport` reflecting the max.
**Depends on:** Real signal that a user crossed the cliff. Until then defer.

### T2 — Outbox DLQ debug screen on mobile
**What:** Settings → Dev tools view showing the mobile MMKV outbox DLQ
(entries that hit 10 retries). Lets a dev or support engineer see what
failed and force-replay.
**Why:** When the outbox starts dropping entries to DLQ in the wild,
there's currently no surface to see why. Sentry will capture the
exception but not the entry contents.
**Pros:** Faster diagnosis; ability to manually retry stuck writes.
**Cons:** Dev-only UX; ~half a day.
**Depends on:** Mobile sync infrastructure shipped (Stage 2 of the
calendar-tap PR).

### T3 — Port enrichment to `@cyggie/services` so gateway can fire it
**What:** Extract `syncContactsFromAttendees` + company-enrichment from
the desktop main-process IPC layer into `@cyggie/services` so the
gateway's `POST /meetings/from-calendar-event` can run the same side
effects as desktop's `prepareMeetingFromCalendarEvent`.
**Why:** Plan-ceo-review 4A: the gateway path currently SKIPS contact
sync + company enrichment. Desktop catches up via Phase 1.5c.
Eventually mobile-originated meetings should produce the same CRM
state as desktop-originated ones, server-side, without waiting for the
user's laptop to come online.
**Pros:** Eliminates the temporal hole; mobile-first users get CRM data
in real-time.
**Cons:** Multi-week port; the enrichment depends on heavy services
(Drive, Gmail, AI) that would need to run server-side.
**Depends on:** Phase 1.5c bidirectional sync (T4).

### T4 — Phase 1.5c: desktop pulls from Neon
**What:** Mirror of `GET /sync/pull` on the desktop side — the desktop
SyncAgent polls the gateway for rows updated by mobile and applies them
to the local SQLite. Closes the round-trip so mobile-originated edits
appear on desktop without a manual refresh.
**Why:** V1 desktop assumes it's the source of truth. Once mobile can
PATCH notes, desktop needs to learn about those updates.
**Pros:** True bidirectional sync; the original 1.5 vision.
**Cons:** Significant: 2-3 weeks. Requires reconciling lamport across
two outboxes (desktop's and mobile's).
**Depends on:** Mobile sync infrastructure shipped (Stage 2).

### T5 — Record button on meeting detail screen
**What:** Add a "Record" button to the mobile meeting detail screen so a
user can tap an upcoming event → see notes → tap Record without going
back to the calendar tab. Recording reuses the existing meeting row
(per `/recordings/upload` find-or-update — already shipped).
**Why:** Workflow polish; current Record FAB is global, not contextual.
**Pros:** Removes a navigation step in the most common flow.
**Cons:** Small UX work — mostly arranging the existing recording
plumbing under a new button.
**Depends on:** Mobile UI shipped (Stage 2).

### T6 — Hostile-QA chaos test
**What:** Maestro / Detox script that types ~1000 keystrokes/sec into
the mobile notes editor while the gateway intermittently 5xxs. Verify
the outbox drains, no entries are lost, and lamport stays monotonic.
**Why:** Plan-eng-review test ambition check — proves resilience under
adversarial conditions.
**Pros:** Catches race conditions our unit tests miss (e.g. coalescing
under high write rate + intermittent failures).
**Cons:** Maestro chaos harness doesn't exist yet; ~3 days to build.
**Depends on:** Mobile sync infrastructure shipped (Stage 2).

### T7 — Maestro E2E flow
**What:** Maestro test for the full happy path: calendar tap → type
notes → background app → resume → re-open meeting → verify notes
restored from MMKV draft + synced via outbox.
**Why:** Plan-ceo-review verification step — this is the demo flow.
**Pros:** Regression guard against the canonical user journey.
**Cons:** Maestro tests are slow + flaky; ~1 day to write + stabilize.
**Depends on:** Mobile UI shipped (Stage 2).

### T8 — Lamport-forgery protection (forge-able locks)
**What:** Both `/sync/push` (Phase 1.5a, shipped) and `PATCH /meetings/:id`
(this PR) use **client-sourced** lamport with Last-Write-Wins compare.
A malicious client could send a huge `lamport` value (e.g. `BigInt.MAX`)
to permanently lock out all future writes from any other device. Both
write paths share this vulnerability; the fix must coordinate them.
**Why:** Caught in plan-ceo-review audit of `/sync/push` (sync.ts:201-225)
before adopting the same primitive in PATCH. Pathological for current
single-firm beta but real for any multi-tenant or hostile-client model.
**Possible fixes:**
- Server-sourced lamport (server increments; client sends `baseLamport`
  it last saw). Requires changing both /sync/push (desktop outbox)
  AND PATCH (mobile outbox) atomically.
- Per-user lamport ceiling: reject any incoming lamport > stored + N
  (where N is some sane batch size like 1000). Cheap; preserves
  client-sourced LWW.
**Pros:** Closes the lockout vector before multi-tenant ships.
**Cons:** Coordinated change across both write paths; risk of
breaking the desktop outbox if not careful.
**Depends on:** Decision on which fix. Recommend ceiling for V1.

### T9 — Mobile calendar tab: show multi-day events (today + next 14)
**What:** The Calendar tab today shows only today's events. Gateway
already returns the next 14 days; mobile filters it down to one day.
Extend to show today (bucketed Earlier/Now/Next/Later as today) +
date-headed sections for the next ~14 days, mirroring desktop's
`groupCalendarEventsByDate` pattern.
**Why:** With zero events today the tab feels empty even when the
user has a meeting tomorrow. Cuts directly against the "what's next"
value the tab is supposed to provide.
**Plan:** Saved at `/Users/sandersoncass/.claude/plans/claude-code-prompt-jolly-eagle.md`
(written during the cathedral-build E2E session). Add `groupByDay()`
+ `formatDayLabel()` to `mobile/lib/api/calendar.ts`; render
multi-section list in `mobile/app/(tabs)/calendar.tsx` keeping the
today buckets intact.
**Effort:** ~80 lines + tests, ~45min.
**Depends on:** Nothing.

### T10 — Gateway Zod: accept ISO datetime with timezone offset
**What:** `POST /meetings/from-calendar-event` uses `z.string().datetime()`
which only accepts `Z` (UTC) suffix. Mobile currently works around it
by `new Date(event.start).toISOString()` before sending — but any other
caller (a script, a future curl test, the desktop sync agent if it
adopts this endpoint) will hit a confusing 400.
**Fix:** change to `z.string().datetime({ offset: true })`. Both UTC
Z and offset forms accepted; gateway can still normalize to UTC
internally via `new Date(...).toISOString()`.
**Why:** Caught in `8c34cfd` E2E run — every tap initially 400'd.
Robustness fix; no behavioral change for the mobile path that now
sends UTC.
**Effort:** 1-line schema change + 1 new test case in
`api-gateway/test/meetings-from-calendar-event.test.ts`.

### T11 — Meeting detail: hide empty stats for `scheduled` rows
**What:** StatsCard renders Duration / Status / Speakers always.
For `status='scheduled'` rows (no recording yet), Duration is `—` and
Speakers is `—`. Two of three cells are empty placeholders.
**Fix:** when meeting.status === 'scheduled', omit Duration + Speakers
cells. Or replace Duration with the calendar slot length once T12
(below) lands.
**Why:** UX polish — surfaced by the cathedral-build E2E review.

### T12 — Persist scheduled end time on meetings table
**What:** `POST /meetings/from-calendar-event` accepts startTime but
not endTime. The detail screen can't render a meaningful "Duration"
for scheduled rows because we never stored the slot length.
**Fix:** Add `scheduled_end_at` (timestamptz, nullable) to meetings
table via a new migration. Persist from /from-calendar-event when the
calendar event has both start + end. Detail screen renders
"60 min scheduled" pre-recording, transitions to actual duration
post-Deepgram.
**Effort:** new migration + schema field + endpoint body field +
detail-screen render + tests. ~half day.

### T14 — Phase 1.5c expansion: pull more tables alongside meetings
**What:** Extend the gateway's `GET /sync/pull` and the desktop's
`applyRemoteMeetings` to also pull `notes`, `contacts`,
`org_companies`, `contact_emails`, `org_company_aliases`. Mirrors the
push-side owned-tables set.
**Why:** Phase 1.5c shipped meetings-only because that's the only
table mobile writes to today. As M5 (chat → chat_sessions /
chat_session_messages) or M6 (settings → user prefs) introduces
mobile writes to other tables, those tables' edits will be stranded
on Neon — same problem 1.5c just solved for meetings.
**Pros:** Symmetric with push side; closes the bidirectional loop
for all owned data.
**Cons:** ~2 weeks of work; gateway response gets bigger; pagination
becomes more urgent (per T1).
**Context:** The applyRemote primitive shipped in 1.5c
([src/main/services/sync-remote-apply.ts](src/main/services/sync-remote-apply.ts))
is the reuse target — copy the hand-rolled camelCase→snake_case
mapping pattern per table. Gateway extends
[api-gateway/src/routes/sync.ts](api-gateway/src/routes/sync.ts) to
return `{ meetings, notes, contacts, ... }` keyed by table name.
**Effort:** L (~2 weeks)
**Priority:** P2 — trigger when M5 ships
**Depends on / blocked by:** M5 (or M6) introducing mobile writes
to the additional tables.

### T15 — Extract `PollingService` base when there's a third polling service
**What:** sync-agent.ts (push) and sync-pull.service.ts (pull) share
patterns: 60s tick, exp backoff (2s → 60s ceiling), state machine
with `idle / pulling-or-flushing / backing_off / paused_no_auth`,
state-change IPC, `lastError` field, `triggerX()` external trigger.
~80 lines of duplicated boilerplate today.
**Why:** Rule of three. Two implementations is fine; three signals
real duplication.
**Pros:** Single source of truth for backoff curve, state transitions,
mutex semantics.
**Cons:** Premature today. The two services have subtly different
edge cases (push has flush-in-flight tracking + ack_pending state;
pull doesn't) — base class would need extension points that don't
exist until we see what the third service needs.
**Context:** Build when the third polling service lands — likely the
real-time SSE/APNs subscriber (Phase 1.5d) or a future job-runner.
[src/main/services/sync-agent.ts](src/main/services/sync-agent.ts) and
[src/main/services/sync-pull.service.ts](src/main/services/sync-pull.service.ts)
are the merge targets.
**Effort:** M (~3 days incl. test migrations)
**Priority:** P3 — code-quality investment, no user-visible effect.
**Depends on / blocked by:** Third polling service landing.

### T16 — Mobile: surface impromptu (no-cal-event) meetings somewhere

**What:** Add a way to find past impromptu meetings on mobile.
Impromptu rows (Record FAB outside any calendar slot) have
`calendar_event_id = null`, so they never appear in the calendar tab's
Past segment. Today they're only reachable via the just-completed
recording flow's auto-navigate; a user who closes the app or kills the
recording screen permanently loses the ability to find that meeting on
mobile.

**Why:** Surfaced during the M6 ship-readiness audit. Mobile's "Past"
segment is calendar-only. Impromptu meetings are real meetings that
need a UI entry point.

**Options:**
- A "My Recordings" section on the calendar tab (above Past?) that
  lists impromptu meetings from the last 7 days.
- A new Meetings tab (would need wireframe + nav rework).
- An "impromptu" row group inside the Past segment, merging calendar
  events + impromptu rows by date.

**Effort:** M (~1 day for option 1; ~3 days for a new tab).
**Priority:** P2 — real gap, but not a blocker for TestFlight cohort 1
since impromptu recordings are rare in the typical "calendar-anchored"
workflow.
**Depends on / blocked by:** Nothing.

### T13 — Mobile: gracefully surface non-401 errors from handleEventPress
**What:** `mobile/app/(tabs)/calendar.tsx`'s tap handler currently
`console.error`s non-reauth errors but doesn't show anything to the
user. A 5xx during prepareMeetingFromCalendarEvent looks like a no-op
tap.
**Fix:** show a small toast / inline error banner. Reuse whatever
toast system gets adopted in M6.
**Why:** Caught during E2E — 400s on early taps were invisible.

### T39 — Memo sync pull-side primitives (multi-desktop V2)
**What:** Mirror the T14 work for memos — add
`applyRemoteInvestmentMemos` + `applyRemoteInvestmentMemoVersions`
primitives in `sync-remote-apply.ts`, extend the gateway `GET /sync/pull`
to return both arrays, wire the pull service + IPC channels
(`INVESTMENT_MEMOS_REMOTE_APPLIED`, `INVESTMENT_MEMO_VERSIONS_REMOTE_APPLIED`).
**Why:** The 2026-05-23 memo-sync commit (push + backfill) closes the
desktop→Neon→mobile path. It does NOT close desktop A → Neon → desktop B,
which only matters once a user runs two desktops. Single-desktop today.
**Pros:** Symmetric with the other 6 tables already on the pull path
(meetings, notes, org_companies, aliases, contacts, contact_emails).
**Cons:** ~half a day, plus tests; zero user value until multi-desktop.
**Context:** Same pattern as commit 27f83fe (T14). Memos in OWNED_TABLES
Layer 3; versions Layer 4. The TableSpec helper makes this mechanical.
**Depends on / blocked by:** First multi-desktop user signal.

---

## P2 — Contacts (Performance)

### Pre-compute contact activity touchpoints
**What:** Add `last_meeting_date` and `last_email_date` columns to the contacts table, updated on write (via triggers or write hooks). Remove the 3 full-table scan functions (`buildLatestMeetingTouchByEmail`, `buildLatestEmailTouchByEmail`, `buildLatestEmailTouchByContactId`) from the read path.
**Why:** When `includeActivityTouchpoint=true`, `listContacts()` runs 3 full-table scans across meetings and email tables on every call. This is the heaviest query in the app and fires on every Contacts page mount. The correct pattern for web/mobile is to move this work from read-time to write-time.
**Pros:** Eliminates O(n) scans on every Contacts load; correct architecture for web/mobile migration; read path becomes a simple column read.
**Cons:** Requires a migration to add columns + backfill existing data; write paths (meeting create/update, email sync) need to update the denormalized columns.
**Context:** The 3 scan functions are in `src/main/database/repositories/contact.repo.ts` lines 641-760. Called when `includeActivityTouchpoint=true` (Contacts.tsx line 388). Write-side update points: meeting creation/update in `meeting.repo.ts`, email sync in `email.repo.ts`. Backfill migration: run the existing scan logic once to populate columns for all existing contacts.
**Effort:** M
**Priority:** P2
**Depends on:** Nothing.

---

## P3 — Contacts

### Talent Pipeline: AI-suggested stage progressions
**What:** When a contact's `talentPipeline === 'identified'` and `meetingCount >= 3`, show a dismissible nudge in the Relationship section: "↑ Move to Exploring?"
**Why:** Surfaces stale stage tracking — you may have moved to regular catch-up calls but forgotten to update the stage. Makes the pipeline self-maintaining.
**Pros:** No extra IPC; `meetingCount` + `lastTouchpoint` are already on `ContactDetail`. ~30 lines of conditional JSX + localStorage for dismissal. Thresholds: `identified` → suggest `exploring` after 3 meetings; `exploring` → suggest `ideating` if `lastTouchpoint` > 90 days old (they've likely decided).
**Cons:** Threshold (3 meetings / 90 days) is arbitrary; per-contact dismissal requires localStorage keyed by `contact.id`.
**Context:** Render a dismissible chip just above the Talent Pipeline `PropertyRow` in the Relationship section of `ContactPropertiesPanel.tsx`. `meetingCount` and `lastTouchpoint` come from `ContactDetail` (already in scope). Dismissal stored in `localStorage` as `cyggie:talent-pipeline-nudge-dismissed:${contactId}` (JSON timestamp). Clear dismissal when user changes stage.
**Effort:** M
**Priority:** P3
**Depends on:** Talent Pipeline field PR (migration 068) merged.

---

## P2 — Contacts

### Contact profile enrichment from notes and emails
**What:** Add "📝 From notes" and "✉️ From emails" options to the Enhance dropdown on Contact Detail (parallel to the company implementation in the "enhance from notes/emails" PR).
**Why:** Users want to enrich contacts the same way they enrich companies — from note content and email snippets. Contact notes often contain rich title/role/location data; emails carry company affiliation and seniority signals.
**Pros:** Full parity between company and contact enrichment; the data sources (`listContactNotes`, `listContactEmails`) already exist.
**Cons:** Contact fields differ from company (title, investorStage, fundSize, linkedinUrl, etc.) — requires a separate `buildContactEnrichmentProposal` helper with its own LLM prompt and diff logic. Also non-trivial: existing contact enrichment from meetings lives in the IPC handler, not a service file — the pattern diverges from companies. UI also diverges: `ContactPropertiesPanel` uses `onEnrichFromMeetings` (a direct callback), not the `onEnhance(source)` dropdown pattern. Both the IPC organization and the UI pattern would need to align with the company implementation before this is clean to build.
**Context:** `listContactNotes(contactId)` in `src/main/database/repositories/contact-notes.repo.ts`, `listContactEmails(contactId)` in `src/main/database/repositories/contact.repo.ts`. Start by extracting contact field diff logic from `contacts.ipc.ts` into `contact-summary-sync.service.ts` (analogous to `company-summary-sync.service.ts`). Then add `CONTACT_ENRICH_FROM_NOTES` and `CONTACT_ENRICH_FROM_EMAILS` IPC channels. UI: align `ContactPropertiesPanel` to the `onEnhance(source)` dropdown pattern before adding new sources.
**Effort:** L
**Priority:** P2
**Depends on:** Company "enhance from notes/emails" PR merged.

---

## P2 — Dashboard

### Recent Touches: date range filter
**What:** Date range picker (7d / 30d / 90d / custom) as a 4th section in the filter panel.
**Why:** Users reviewing a specific period (e.g. last week's deal flow) can't constrain by date; the list always shows the most recent 20 items.
**Pros:** Natural extension of the new multi-section filter — `DashboardActivityFilter.dateRange` field + `WHERE datetime(occurred_at) >= ?` SQL clause. Presets (7d/30d/90d) cover most use cases without a custom date picker.
**Cons:** Custom date UI adds complexity; preset options may be sufficient without it.
**Context:** The `listRecentActivity()` function in `src/main/database/repositories/dashboard.repo.ts` builds UNION SQL from per-type fragments. Adding a date clause would go in the final ORDER BY wrapper (currently `SELECT * FROM (...) ORDER BY occurred_at DESC LIMIT ?`). The filter panel in `src/renderer/routes/Dashboard.tsx` already has the three-section chip pattern to follow — add a 4th `.filterSection` with preset chips. `DashboardActivityFilter` in `src/shared/types/dashboard.ts` would gain an optional `dateRange: '7d' | '30d' | '90d' | null` field (null = no date constraint).
**Effort:** M
**Priority:** P2
**Depends on:** Dashboard activity filter panel (merged).

---

## P2 — AI Chat

### "You also asked about this last week" peek banner
**What:** Subtle one-line banner above the chat input when the current context has prior recent sessions: "You have 2 prior chats about Acme Corp →" linking to the History modal filtered to that context.
**Why:** Surfaces history at the moment of intent. Reduces "I asked this before" duplication.
**Pros:** High-impact UX moment; bridges the chat-history modal with the in-flow chat experience.
**Cons:** Requires UX care — when to show, dismiss persistence, which sessions count. Risk of becoming annoying.
**Context:** ChatInterface.tsx renders the bottom-bar input. Add a banner that queries `CHAT_SESSION_LIST_RECENT({contextId, limit:3})` on mount and renders if any non-current sessions exist. Persist dismissals per context in localStorage.
**Effort:** S–M
**Priority:** P2
**Depends on:** Chat-history feature shipped (✅).

---

### Contextual suggested questions in chat
**What:** Show 3 contextual AI suggestions when user focuses the chat input (before they type anything).
**Why:** Lowers friction — users see what they can ask; matches the design mockup.
**Pros:** High engagement lift; suggestions can be pre-generated when the page loads.
**Cons:** Requires per-context suggestion generation (LLM call on first focus).
**Context:** Add `suggestionsState` to `ChatInterface`, fire an IPC call on first focus if suggestions are empty. Show a `SuggestionsList` inside the widget before the panel opens (i.e., when the input is focused but no question has been asked yet). Suggestions should be context-aware — different for a company page vs. meeting detail vs. dashboard. The current entity context is available via `useChatStore().pageContext` — use `pageContext.contextOptions[0]` for entity pages, `pageContext.meetingId` for meeting detail, and `null` pageContext for dashboard/global.
**Effort:** L
**Priority:** P2
**Depends on:** Chat modal redesign (floating-everywhere migration) merged first.

---

## P3 — AI Chat

### Message-list virtualization in PanelThread
**What:** Add `react-window` (or `@tanstack/react-virtual`) to virtualize PanelThread once chats routinely exceed ~500 messages.
**Why:** Markdown re-renders during streaming compound with list size. p99 render time will degrade past ~500 messages, especially with the RAG/cross-chat retrieval feature also under P3.
**Pros:** Future-proofs the longest-running chats; bounded memory.
**Cons:** Complicates scroll restoration (variable item heights); breaks Cmd+F find-in-page for unmounted messages; "select-all-and-copy-transcript" only grabs mounted ones.
**Context:** `<PanelThread/>` lives in `src/renderer/components/chat-panel/PanelThread.tsx`. Today it renders all messages directly. Virtualization should preserve the existing `stuckToBottomRef` auto-scroll behavior.
**Effort:** M
**Priority:** P3
**Depends on:** AI Chat side panel shipped (✅).

---

### "Continue this thread" cross-context follow-up
**What:** Chat panel can ask "across all my Acme chats" via FTS5 retrieval before LLM call. Inject relevant prior turns as context.
**Why:** Cathedral-grade chat platform. Turns chat history into a knowledge substrate rather than independent threads.
**Pros:** Compounding value of the chat-history feature; differentiating UX.
**Cons:** Prompt engineering work to inject prior turns without confusing the model; needs careful token budgeting.
**Context:** With `chat_session_messages_fts` populated, the retrieval is straightforward — query FTS5 for top-k matches in the same context (or globally), pull message content, prepend to the LLM prompt. Wire into `withChatPersistence` or a new helper.
**Effort:** M
**Priority:** P3
**Depends on:** Chat-history feature shipped (✅).

---

### Chat-as-context for memo / key-takeaways generators
**What:** Memo and key-takeaways generators can pull relevant chat sessions as context when generating outputs.
**Why:** Closes the loop — chats become an investment of time that pays off in derived artifacts (memos, takeaways).
**Pros:** Removes "tell the LLM what we discussed" boilerplate; surfaces nuanced reasoning the user explored in chat.
**Cons:** Token budget pressure; must rank relevance.
**Context:** memo-generator.ts and company-key-takeaways.ts both build prompts. Add an optional "include recent chat sessions" pass that queries `chat_session_messages_fts` or `listRecent({contextId})` and prepends.
**Effort:** M
**Priority:** P3
**Depends on:** Chat-history feature shipped (✅).

---

### Project-wide encryption-at-rest for SQLite
**What:** Adopt SQLCipher (or equivalent) for the project's SQLite database.
**Why:** Stolen-laptop threat model. Chats, contacts, meetings, notes all contain sensitive deal info today, stored in plaintext SQLite.
**Pros:** Closes a real-world attack vector.
**Cons:** Driver footprint change; key-management decision (where does the key live?); migration risk.
**Context:** Project-wide decision, not chat-specific. Consider one-shot migration that re-creates the DB encrypted, or rely on OS-level disk encryption as the threat model. Currently flagged in chat-history plan as deferred.
**Effort:** L
**Priority:** P3
**Depends on:** None.

---

### Global chat search observability
**What:** Log which search strategy (Strategy 0 AND co-person, Strategy 1 FTS, Strategy 2 title, Strategy 3 speaker) surfaced each meeting in `queryGlobal`.
**Why:** Currently there's no way to understand why specific meetings were or weren't returned. When users report "it didn't find the right meeting", the only recourse is guessing which strategy failed.
**Pros:** Makes future search quality regressions diagnosable without code changes. ~10 lines.
**Cons:** Logging in the main process goes to stdout/electron log — not visible in the renderer without additional tooling.
**Context:** In `src/main/llm/chat.ts`, `queryGlobal` collects results from 4 strategies into `searchResults[]`. Tagging each entry with its source strategy (e.g., `strategy: 'and-person' | 'fts' | 'title' | 'speaker'`) and logging the final 15 in a `console.debug` call (dev only, guarded by `process.env.NODE_ENV === 'development'`) would give full visibility. The `searchResults` type would need a `strategy` field.
**Effort:** S
**Priority:** P3
**Depends on:** None.

---

## P3 — Companies

### Companies table: server-side pagination
**What:** Replace the full-fetch architecture in Companies.tsx with server-side pagination (cursor- or offset-based) + virtual scrolling in the table.
**Why:** Currently `fetchCompanies()` fetches ALL companies in one query (no limit, as of the 2026-04-14 limit-removal fix). `baseCompanySelect` uses LEFT JOIN aggregates for meeting_count, email_count, note_count, contact_count, and last_touchpoint — O(n) in company count. At 760 companies today this is fast. At 5000+ it will become perceptible (<500ms today; could hit 2–5s at 5k).
**Pros:** Correct at true scale; opens the door for infinite scroll or page-based navigation. Filtering and sorting would move to the backend, eliminating the client-side JS filter pass.
**Cons:** Requires moving columnFilters, rangeFilters, and textFilters to the backend query (currently all client-side). The filter URL param → server query translation layer is non-trivial. The Companies table currently supports multi-field sort client-side; server-side would need to replicate `buildCompanyOrderBy` for all sort keys.
**Context:** `buildUrlFilter` in `src/renderer/components/company/companyColumns.ts` now passes no limit (view: 'all'). `listCompanies` in `src/main/database/repositories/org-company.repo.ts` skips LIMIT/OFFSET when limit is undefined. The full client-side filter chain is now a 6-pass chain (built-in select/range/text + custom select/range/text) in `filterCompanies` (`companyColumns.ts`), backed by helpers in `src/renderer/components/crm/tableUtils.ts`. Start by adding `entityTypes`, `pipelineStage`, and `priority` server-side filter params to `CompanyListFilter`, then update `buildUrlFilter` to pass them when active. Pagination can follow as a second step.
**Effort:** XL
**Priority:** P3
**Depends on:** None. Can be done incrementally — start with server-side entityType/stage/priority filtering (high value, lower effort) before tackling pagination.
**Enabled by:** "Preserve filtered/saved view + custom-field URL gap" (back-nav PR) — the URL is now the authoritative source of truth for ALL column filter types (built-in + custom select/multiselect/range/text). Server-side translation can map URL params 1:1 without inventing a new filter wire format.

---

## P3 — Contacts

### Undo merge
**What:** 10-second undo window after a manual merge closes, letting the user restore the deleted contact(s).
**Why:** Manual merge is a one-way door today. A mis-merge (wrong keep contact, accidental trigger) forces manual contact recreation with no recovery path.
**Pros:** Safety net that removes the hesitation around using the merge feature; follows established undo patterns.
**Cons:** Requires snapshotting source contact rows client-side before calling merge (or a server-side soft-delete), plus a new `CONTACT_RESTORE` IPC to recreate deleted contacts.
**Context:** Added in the manual merge PR (Merge Contacts feature). The `mergeContactsIntoOne` function in `contact.repo.ts` deletes source contacts atomically. Simplest client-side approach: snapshot the `mergeDialogContacts` array (all `ContactSummary` rows) before calling `handleMerge`, store as `mergeUndoSnapshot`. After close, show a 10-second undo toast (`undoTimerRef` pattern from `ContactTable`). On undo click, call `CONTACT_RESTORE` with the snapshot rows. The restore IPC would need to handle re-creating a contact with the original `id` or accept a new ID and re-link meetings/emails.
**Effort:** M
**Priority:** P3
**Depends on:** Manual merge feature (this PR) merged.

---

## P3 — Notes

## P3 — Meeting Detail

### Copy AI Summary to clipboard button
**What:** Small copy icon in the `.summaryDivider` header row next to "✦ AI SUMMARY & ACTION ITEMS". `navigator.clipboard.writeText(summaryDraft)` → brief "✓ Copied" confirmation state.
**Why:** Partners frequently paste meeting summaries into emails/Slack. One-click copy saves the select-all + copy flow.
**Pros:** ~15 min effort; no new state needed beyond a 1s `copied` boolean.
**Cons:** The Share → Copy text action already covers this use case indirectly.
**Context:** Add a `<button>` in the `.summaryDivider` flex row (right side). `const [copied, setCopied] = useState(false)`. On click: `await navigator.clipboard.writeText(summaryDraft); setCopied(true); setTimeout(() => setCopied(false), 1000)`. Style as a small ghost icon button similar to `.noteFooterBtn`. The `.summaryDivider` already has `justify-content: space-between` to accommodate a right-side action.
**Effort:** S
**Priority:** P3
**Depends on:** Meeting Detail redesign PR (summaryCard wrapper must exist — completed).

### Speaker editing for finalized transcripts
**What:** Allow renaming and contact-linking of transcript speakers in already-recorded (finalized) meetings.
**Why:** After a recording ends, the speaker chips in the live transcript disappear. Users have no way to label or link "Speaker 1" to a contact for finalized meetings.
**Pros:** Completes the speaker-attribution workflow end-to-end; useful for retrospective review of old meetings.
**Cons:** Finalized transcripts are markdown strings — speaker labels are baked in. Requires either parsing the markdown for speaker patterns to make labels interactive, or a side-panel speaker mapping UI separate from the transcript text.
**Context:** This was explicitly deferred in the meeting header chips redesign PR. The live recording path now shows editable speaker chips in the transcript panel (`isThisMeetingRecording` block in `MeetingDetail.tsx`). The finalized path renders the transcript via `ReactMarkdown` with no interactive labels. Start near the `transcriptTab` section and the `localSpeakerMap` / `speakerContactMap` state.
**Effort:** L
**Depends on:** Meeting header chips redesign PR.

---

## P2 — Partner Meeting

### Batch brief generation for active digest
**What:** "Generate all briefs" button in the `PartnerMeeting` header. Loops through all active digest items where `brief = null && companyId != null`, calls `PARTNER_MEETING_GENERATE_BRIEF` + `PARTNER_MEETING_ITEM_UPDATE` for each sequentially, with a progress counter (e.g., "Generating 3/8…") and an abort button.
**Why:** Partners with 8+ companies would need to click "✨ Generate from CRM data" 8+ times individually. A single action at the start of meeting prep is the natural UX flow.
**Pros:** Covers the "historical imported items" case in bulk. Mirrors the Reconcile pattern already in `PartnerMeeting.tsx` (abort button, `handleConclude` guard).
**Cons:** Multiple sequential LLM calls (~5–15s each) — needs a cancellable loading state so the user isn't blocked.
**Context:** `PartnerMeeting.tsx` has all digest items in state. Per null-brief item: call `PARTNER_MEETING_GENERATE_BRIEF`, then `PARTNER_MEETING_ITEM_UPDATE`. Call `handleItemsChange` after each to update UI incrementally. Show "Generating 3/8…" and an abort button (AbortController pattern from `handleConclude`). Button should be hidden when all items have briefs or when there are no active items.
**Effort:** M
**Priority:** P2
**Depends on:** Single-item "✨ Generate from CRM data" button (this PR) merged.

---

## P3 — Partner Meeting

### NewCompanyModal component tests (RTL)
**What:** RTL tests for `NewCompanyModal` covering the `addToPartnerSync` checkbox routing — the 4 codepaths (deck/manual × checked/unchecked).
**Why:** The checkbox boolean gate has zero automated coverage. Most dangerous regression: checkbox unchecked but IPC still firing.
**Pros:** RTL + vitest is in the project already (`@testing-library/react@^16.0.0`); pattern is well-established.
**Cons:** The checkbox renders ONLY at `step === 'review-form'` (NewCompanyModal.tsx:512+), not at the default `'source-picker'` step. Reaching review-form requires going through source picker + ingestion + dedup, which means mocking 6+ IPC channels (COMPANY_FIND_OR_CREATE, COMPANY_UPDATE, CONTACT_CREATE, PARTNER_MEETING_*, SETTINGS_GET) plus the global `Notification` API and `react-router` navigation. An earlier draft test that just rendered the modal at the default step couldn't reach the checkbox — discovered while shipping the cleanup-bundle PR. M effort, not S.
**Context:** Two viable approaches: (a) full RTL test with all required mocks — best fidelity but ~150 lines of test scaffolding; (b) refactor: extract the partner-sync decision into a pure helper alongside the modal, test that in isolation, and keep the modal a thin renderer. Option (b) is cleaner long-term but is a real refactor. The earlier inline-test attempt was deleted because it gave false confidence (checked rendering, didn't test routing). Start in `src/tests/NewCompanyModal-partner-sync.test.tsx`. See `src/tests/contact-panel-meta-save-error.test.tsx` if it exists for a model — otherwise `src/tests/Pill.test.tsx` is the simplest existing RTL test in the project.
**Effort:** M
**Priority:** P3
**Depends on:** Decide between full-RTL (a) vs decision-helper-extraction (b) approach.

---

### URL deck → partner sync brief (untested)
**What:** Verify that URL-sourced pitch decks produce good partner sync brief content via the new VC analysis pipeline.
**Why:** `callLlm()` is shared between PDF and URL ingest paths, so URL decks automatically get `rawText` set and will flow through the full VC analysis pipeline. However, URL text is scraped via `document.body.innerText` from a headless BrowserWindow and may be noisier than PDF-extracted text, potentially producing poor brief quality or hallucinated fields.
**Pros:** If it works cleanly, URL decks get the same partner sync treatment for free with no additional code.
**Cons:** Noisy web-scraped text may produce unreliable structured fields (especially Founder LinkedIn, key metrics).
**Context:** Test by ingesting a URL-based deck (DocSend, Pitch.com). Check: (1) partner sync brief quality, (2) company note content, (3) whether conditional fields (Location, Website, LinkedIn) are correctly omitted when absent. Add a test case to `src/tests/pitch-deck-brief.test.ts` with a mock rawText simulating web-scraped noise (e.g., nav menus, cookie banners, repeated footer text).
**Effort:** S
**Priority:** P3
**Depends on:** Pitch deck → note → brief PR merged.

---

## P3 — Memo

### Memo version history UI
**What:** Version history panel for investment memos — list prior versions, preview content, restore a version.
**Why:** Users can't recover or review previous AI-generated or manually-edited versions. The `v{n}` badge implies history exists but there's no way to access it. After generating a bad memo, users have no rollback path.
**Pros:** Completes the versioning story end-to-end; the DB already stores all versions with timestamps and change notes.
**Cons:** Non-trivial UI — needs version list, preview, and restore action; requires a new IPC channel to fetch version list.
**Context:** `investment_memo_versions` table has all data (id, memo_id, version_number, content_markdown, change_note, created_by, created_at). Check if `INVESTMENT_MEMO_GET_VERSIONS` channel exists in `src/main/ipc/investment-memo.ipc.ts` or add one. UI: click the `v{n}` badge in `CompanyMemo.tsx` toolbar to open a version list (dropdown or side panel), show timestamp + change note per entry, click to preview, button to restore (saves as new version). Start in `CompanyMemo.tsx` + `investment-memo.ipc.ts`.
**Effort:** M
**Priority:** P3
**Depends on:** This PR merged (version is saved on generate; version number is tracked on memo state).

---

## P3 — Pipeline View

### Pipeline search result count
**What:** Show "14 companies" label next to the `headerSearch` input when `filterQuery` is active.
**Why:** Immediate feedback on how filtered the view is — especially useful when toggling between board and table views with a filter active.
**Pros:** ~15 min effort; `filteredCompanies.length` is already computed.
**Cons:** Minor visual clutter if label is always present; show only when `filterQuery.length > 0`.
**Context:** `filterQuery` and the filtered company arrays are all in `src/renderer/routes/Pipeline.tsx`. Render `<span className={styles.searchCount}>{n} companies</span>` in `headerRow`, conditionally visible. Add `.searchCount` style (muted, small text) to `Pipeline.module.css`.
**Effort:** S
**Depends on:** Pipeline search bar relocation (this PR).

---

### Pipeline search clear button
**What:** Small "×" button inside the `headerSearch` input when `filterQuery.length > 0`.
**Why:** One-click clear without select+delete — standard search input affordance; especially useful after switching views and realizing a filter is still active.
**Pros:** ~20 min effort; reuses existing `setFilterQuery` setter.
**Cons:** Requires wrapping the `<input>` in a relative-positioned container.
**Context:** In `Pipeline.tsx` `headerRow`, wrap `<input className={styles.headerSearch}>` in `<div className={styles.headerSearchWrap}>`, absolute-position a `<button onClick={() => setFilterQuery('')}>×</button>` on the right, show only when `filterQuery.length > 0`. Add `.headerSearchWrap` and `.headerSearchClear` to `Pipeline.module.css`.
**Effort:** S
**Depends on:** Pipeline search bar relocation (this PR).

---

## P3 — Dedup

### Fuzzy dedup threshold tuning
**What:** `FUZZY_THRESHOLD = 0.88` is an empirical choice. It may produce false positives (grouping distinct people/companies) or false negatives (missing obvious dupes) at scale.
**Why:** A production dataset with diverse names will expose edge cases not covered by the 4-test suites. Users seeing incorrect groupings will lose trust in the dedup feature.
**Pros:** Better precision/recall; could add a user feedback/dismiss mechanism.
**Cons:** Requires real data sampling to tune; adding dismiss UX is medium effort.
**Context:** The threshold is a single constant (`FUZZY_THRESHOLD = 0.88`) defined in both `src/main/database/repositories/contact.repo.ts` and `org-company.repo.ts`. The Jaro-Winkler function is in `src/main/utils/jaroWinkler.ts`. Track false-positive/negative user reports from the dedup UI → adjust constant → re-run test suite.
**Effort:** S (constant tuning) / M (user dismiss/feedback mechanism)
**Depends on:** Fuzzy dedup shipped (this PR).

---

## P2 — CRM Tables

## P2 — Custom Fields

### Option management: rename, delete, reorder
**What:** Let users rename existing options, delete them (with usage count warning), and drag to reorder in a field definition editor.
**Why:** Once users can add options inline, the next friction point is cleanup — typos, obsolete values, wrong ordering.
**Pros:** Full taxonomy control without going to Settings for every change.
**Cons:** Requires a popover/modal UI for the option list; rename needs a migration for existing field values using the old option name.
**Context:** `addCustomFieldOption` in `customFieldUtils.ts` is the foundation. A popover showing the current `optionsJson` list with rename/delete/drag controls is the UI target — similar to Notion's property option editor. The IPC is already there (`CUSTOM_FIELD_UPDATE_DEFINITION`). Start in `CustomFieldsPanel.tsx` (gear icon next to label?).
**Effort:** L
**Priority:** P2
**Depends on:** Add-option PR (this PR).

---

## P3 — Contact Enrichment

### Per-field dismiss in contact enrich dialog
**What:** "Don't suggest this field again" option in the contact enrich dialog.
**Why:** If a user deliberately leaves phone empty (doesn't want to share it), they'll see a phone proposal on every meeting. The Skip button dismisses the whole dialog; there's no way to suppress just one field.
**Pros:** Removes repetitive noise for intentionally-empty fields.
**Cons:** Requires storing dismissed fields per-contact — could reuse `field_sources` with a sentinel value like `"dismissed"`.
**Context:** `field_sources` column (migration 048) stores `{title: meetingId}` for enriched fields. Extend with `{phone: "dismissed"}` to suppress future suggestions. In `contact-summary-sync.service.ts`, the service already reads `contact.fieldSources` before building proposals — add a check `if (existingSources[field] === 'dismissed') skip`. UI change: add a small "×" dismiss button per field in the contact enrich dialog (both `MeetingDetail.tsx` and `ContactDetail.tsx`).
**Effort:** S
**Priority:** P3
**Depends on:** Contact enrichment flow (migration 048 + contact-summary-sync.service.ts).

---

## P2 — Company Fields

### Source Name enrichment from meetings
**What:** Auto-suggest `source_entity` (the person or firm who introduced a deal) from meeting attendee/invite context — e.g., "warm intro from John Smith at Sequoia" in a calendar description.
**Why:** Source Name is currently manual-only. Meeting metadata often contains exactly this signal, making it a natural fit for the existing enrichment flow.
**Pros:** Surfaces deal provenance without manual entry; consistent with the existing enrichment proposal UX users already know.
**Cons:** Requires fuzzy entity resolution from free text (ambiguous company/contact matches when the name partially overlaps); medium effort; LLM may hallucinate names not in the database.
**Context:** `source_entity_type` + `source_entity_id` columns ship in migration 056. The integration point is `company-summary-sync.service.ts` `getCompanyEnrichmentProposalsFromMeetings()`. Add `"sourceIntroducedBy": name of person or firm who introduced this deal, or null` to the LLM prompt's `builtinFields`, then fuzzy-match the returned string against contacts (`full_name`) and companies (`canonical_name`) — similar to how contact enrichment resolves company links. If exactly one match above a threshold, emit a proposal with `sourceEntityId` + `sourceEntityType`. If ambiguous, skip (don't propose).
**Effort:** M
**Priority:** P2
**Depends on:** Migration 056 + company new fields PR (source_entity_type/source_entity_id columns must exist first).

---

## P2 — Enrichment

### Enrichment run history
**What:** Track every enrichment run (timestamp, meeting IDs, fields changed) per company/contact.
**Why:** `lastEnrichedAt` in localStorage is a weak signal — it's device-specific, invisible in the UI, and provides no audit trail. If a user enriches on device A, device B still shows the banner.
**Pros:** Persistent cross-device history; enables "what changed and when" view; better banner suppression logic (check if latest meeting has already been used).
**Cons:** Requires a new DB table; medium schema + service work.
**Context:** Currently `localStorage.setItem('company_enriched_at_${id}', ...)` and `contact_enriched_at_${id}` store ISO timestamps. A proper `enrichment_runs` table would have columns: `id`, `entity_type` (company/contact), `entity_id`, `meeting_ids` (JSON array), `fields_changed` (JSON array), `created_at`. The banner suppression check in `CompanyDetail.tsx` and `ContactDetail.tsx` (`showEnrichBanner` useMemo) would query this table instead of localStorage.
**Effort:** M
**Priority:** P2
**Depends on:** Company enrichment feature (this PR).

---

### Migrate auto-gen company enrichment to LLM
**What:** `getVcSummaryCompanyUpdateProposals()` still uses regex-based extraction (`parseVcPitchSummary()`). Align it with the new LLM approach used by `getCompanyEnrichmentProposalsFromMeetings()`.
**Why:** Regex extraction is brittle for varied summary formats; misses custom fields entirely; the three extraction strategies (regex auto-gen, meeting enrichment LLM, pitch deck ingestion LLM) use different approaches for the same goal. Unification would allow custom fields to be populated across all paths.
**Pros:** Unified code path; custom fields populated on first summary; more robust extraction.
**Cons:** LLM adds latency to summary generation (already has one LLM call; this adds another or requires combining them); harder to test without mocking.
**Context:** `getVcSummaryCompanyUpdateProposals()` is called from `summary.ipc.ts` during `SUMMARY_GENERATE`. It feeds `companyUpdateProposals` in `SummaryGenerateResult`. The regex path is fast and appropriate for first-meeting auto-fill (no prior data). Full migration may be premature; consider a hybrid: regex for speed, LLM only when custom fields are defined. Note: pitch deck ingestion (`src/main/services/pitch-deck-ingestion.service.ts`) is now the third extraction strategy — the three strategies should eventually share a unified extraction pipeline.
**Effort:** M
**Priority:** P3
**Depends on:** Company enrichment feature (this PR).

---

## P3 — Pitch Deck

### Deck file storage after ingestion
**What:** After ingesting a PDF pitch deck, save its file path to the company record so it appears in the CompanyFiles tab and can be re-ingested later for updated rounds.
**Why:** Currently the PDF is read, extracted, then forgotten. Users who receive updated decks have no record of which PDF was last ingested, and can't easily re-run ingestion on a newer version of the same deck.
**Pros:** Closes the loop on the ingestion workflow; makes the deck discoverable in context; enables future "re-ingest" action from CompanyFiles.
**Cons:** File paths are device-specific — storing a local path only works on the same machine; cloud storage or a copy-into-app-folder approach would be needed for multi-device.
**Context:** After `COMPANY_PITCH_DECK_INGEST` completes successfully with a PDF source, call a new `COMPANY_FILE_ADD_LOCAL` IPC (or extend `CompanyFiles`) to record the PDF path. The `CompanyFiles` tab (in `src/renderer/components/company/CompanyFiles.tsx`) already exists. A simple approach: add `pitchDeckPath TEXT` column to `companies` table (migration). More general approach: extend the existing company_files mechanism to store the path as a pinned file.
**Effort:** M
**Priority:** P3
**Depends on:** Pitch deck ingestion feature (this PR).

---

## P3 — Integrations

### Drive scope revocation
**What:** IPC to revoke individual Drive scopes (Uploads or Files) without disconnecting all of Google Calendar.
**Why:** Currently users who grant Drive access by mistake have no recovery path except full Calendar disconnect. Drive Uploads and Drive Files toggles are permanently disabled once ON.
**Pros:** Completes the Drive UX — every toggle becomes genuinely reversible.
**Cons:** Complex: Google OAuth doesn't support revoking individual scopes from a token. Would require re-auth with a reduced scope list and token replacement, or calling the token revocation endpoint and forcing re-connect.
**Context:** `google-auth.ts` stores granted scopes in `google_calendar_granted_scopes`. A "revoke Drive" flow would need to re-run `runAuthorizationFlow` with only `calendar.readonly` scopes (dropping `drive.file`), replacing the existing token. The IPC surface would need a `DRIVE_REVOKE` channel in `calendar.ipc.ts`. The Drive Uploads and Drive Files sub-row toggles in `IntegrationsPanel.tsx` currently show `disabled` with a `title` tooltip: "Revoke by disconnecting Google Calendar".
**Effort:** L
**Priority:** P3
**Depends on:** IntegrationsPanel redesign PR merged.

---

## P2 — Email Sync

## P1 — Layout Persistence

### Cross-device layout sync
**What:** Persist `fieldPlacements`, `addedFields`, and `sectionOrder` prefs in SQLite instead of localStorage.
**Why:** localStorage is per-device. Two devices see different field layouts. The upcoming web version cannot use localStorage at all.
**Pros:** Consistent UX across devices; survives reinstalls and new devices; required for the web version.
**Cons:** Requires new DB table + IPC channels + usePreferencesStore hydration on startup; medium schema work.
**Context:** Currently all three prefs are stored via `usePreferencesStore` which reads/writes localStorage (`cyggie:contact-added-fields`, `cyggie:contact-field-placements`, `cyggie:contact-sections-order`, and company equivalents). Migration path: new `user_layout_prefs(entity_type TEXT, pref_key TEXT, value_json TEXT, updated_at TEXT)` table. New IPC `PREFS_GET`/`PREFS_SET`. `usePreferencesStore` hydrates from DB on startup + fire-and-forget writes. Build as its own focused PR after the detail panel UX overhaul ships; plan alongside web version work. **Key pattern expansion (layout profiles PR):** The key space now includes per-entity and per-profile-type variants. The migration must cover these patterns in addition to the base keys: `${baseKey}:company:${entityId}` (per-company override), `${baseKey}:entity:${profileType}` (entity-type template, e.g. `vc_fund`, `lp`). Affected base keys: `cyggie:company-hidden-header-chips`, `cyggie:company-header-chip-order`, `cyggie:company-added-fields`, `cyggie:company-field-placements`, `cyggie:company-sections-order`, and all `contact-` equivalents. The sync table should store these as-is (the `pref_key` column holds the full qualified key including `:company:${id}` suffix).
**Effort:** M
**Priority:** P1
**Depends on:** Detail panel UX overhaul PR (field-placements, added-fields, sections-order prefs).

---

## P3 — Layout Tools

## P3 — Header Panel UX

### Bulk "Add all section to header" button
**What:** A per-section `↑ All` link in edit mode that adds all fields in that section to the header chips in one click.
**Why:** If a user has 5+ fields in a section and wants to surface all of them as chips, clicking the × drag for each is tedious. A bulk action removes friction.
**Pros:** Zero-friction for power users building info-dense headers; consistent with the drag-to-header paradigm already in place.
**Cons:** Could create visual clutter if users accidentally bulk-add many chips. Requires a "dedup-safe" bulk togglePinnedKey call.
**Context:** The drag-to-header system (Change 1) is complete: dragging a field to the Header section auto-adds it to `cyggie:contact-summary-fields` / `cyggie:company-summary-fields` via `computeChipDelta`. A bulk add would call `togglePinnedKey(chipId, true)` for each field in the section that isn't already in `pinnedKeys`. The `+ All` button would appear next to the `+ Add field` button in each section in edit mode (only visible when the section has fields not yet in the header). Start in `ContactPropertiesPanel.tsx` and `CompanyPropertiesPanel.tsx` in the `renderSectionedFields` callers.
**Effort:** S
**Depends on:** Header section unification PR (drag-to-header, Change 1).

### Audit header/inline editable fields for asymmetric edit/view gating
**What:** Sweep `CompanyHeaderCard`, `ContactPropertiesPanel`, and `MeetingDetail` header for fields where a visibility gate wraps BOTH the edit-mode and view-mode branches (the bug class fixed for `description` on company detail). The correct pattern is: gate only the view-mode branch; in edit mode always render the editable PropertyRow (mirroring the Website field at `CompanyHeaderCard.tsx:361-362` and the description fix at `CompanyHeaderCard.tsx:333-365`).
**Why:** Same UX dead-end as the company description bug — empty fields become uneditable when they should be editable in edit mode. A user trying to fill in an empty field has no affordance to do so.
**Pros:** Pattern is now established by the description fix. Sweep is mechanical: grep for `show(` / `showField` / similar visibility helpers wrapping a `isEditing ?` ternary.
**Cons:** Some fields may be intentionally hidden in edit mode (e.g. derived/computed fields). Each find needs a judgment call.
**Context:** Start by grepping for `isEditing ?` inside `CompanyHeaderCard.tsx`, `ContactPropertiesPanel.tsx`, `MeetingDetail.tsx` and any sibling header components. The fix in `CompanyHeaderCard.tsx` (the description PR) is the reference pattern.
**Effort:** S
**Priority:** P3
**Depends on:** Company description edit-mode fix merged.


---

## P2 — Tests

### React render testing infrastructure for mobile/
**What:** Stand up `@testing-library/react-native` (or `react-test-renderer`) for the `mobile/` workspace and add render tests for `RecordScreen`'s full state matrix (idle → recording → uploading → transcribing → done → error, plus the pendingUpload-loading branch).
**Why:** Mobile currently has unit tests only for pure-function decision logic (`mount-action.ts`, `poll-action.ts`, `status-pill.ts`, `session.ts`, `pending-upload.ts`). Render-level bugs slip through unchecked. The recording screen has now had **6 user-visible regressions in a single session** (`a8d545e`, `1205ff0`, `ae71266`, `03b7604`, `206eb57` mount-action extract, and this one) — every one of them was a state→UI rendering mismatch. The mount-action.ts extraction covered the decision logic with 11 tests, but cannot catch the kind of bug fixed here (idle and recording sharing one render branch).
**Pros:** Catches render-level regressions before they ship; lets us assert "when status=X, the user sees Y" for the RecordScreen and (eventually) MeetingDetail, RetryUploadBanner, EmptyTranscriptBanner. Aligns with the pure-function test culture already in place (state matrix is the same thing, just one layer up).
**Cons:** ~Half-day of infra setup (vitest config + jest-dom-equivalent for RN + mock for `expo-av` / `expo-router` / `react-native-safe-area-context`); ongoing maintenance of mocks as the screen evolves. Could be premature if regressions stop after this one.
**Context:** The natural first test would assert: given a fresh mount with `storeStatus='idle'` and `pendingUpload=null`, the rendered tree shows the spinner + "Starting…" text and **NOT** the timer (the regression this PR fixes). Other valuable cases: `status='recording'` shows the timer with the formatted elapsed; `status='error'` with a pendingUpload shows the retry banner. Mock-surface inventory: `expo-av` (already faked in `session.test.ts`), `expo-router` (just need a `router.back()` no-op), `react-native-safe-area-context` (provider). Trigger to ship: 6th regression in this area was the threshold — if this PR's JSX-only fix lands cleanly and there's no 7th, we can defer further; if another render regression hits, that's the signal to do this.
**Effort:** M (half-day infra + 5-10 render tests for `RecordScreen`)
**Priority:** P2
**Depends on:** Nothing — independent of in-flight mobile work.

## P2 — Notes Import

## P2 — Notes

---

## P3 — Refactoring

### Centralize parseEmailParticipants
**What:** Audit `parseEmailParticipants` for signature drift across `contact-utils.ts`, `meeting.repo.ts`, and `org-company.repo.ts`. Consolidate the canonical version into `src/main/utils/db-utils.ts` alongside the other parsers.
**Why:** `parseTimestamp` + `parseJsonArray` were consolidated into `db-utils.ts` (cleanup-bundle PR), but `parseEmailParticipants` was deferred because the variants may handle different fields (`contactId` presence, allowed `role` set).
**Pros:** Unified parsing; easier to extend the participant role set.
**Cons:** Signatures may differ across copies — needs careful reconciliation to avoid behavior changes. Pre-bundle audit confirmed `parseJsonArray` was identical across copies, but did NOT cover `parseEmailParticipants`.
**Context:** Canonical location is now `src/main/utils/db-utils.ts`. `parseEmailParticipants` was left in `contact-utils.ts` during the cleanup-bundle PR. Diff against any copies in `meeting.repo.ts` / `org-company.repo.ts` first; if identical, mechanical move + re-export from contact-utils for backward compat.
**Effort:** S
**Priority:** P3
**Depends on:** Nothing (parseTimestamp / parseJsonArray central done).

---

### IPC validation/audit boilerplate reduction
**What:** Extract the repeated `if (!param) throw new Error('X is required')` + `logAudit(userId, ...)` pattern from all IPC handler files into a small set of helpers.
**Why:** 70+ occurrences of the same validation + audit logging pattern across all IPC files — any change to the audit schema or error format touches every file.
**Pros:** One change propagates everywhere; handlers shrink to pure business logic.
**Cons:** Adds indirection; cross-cutting change touches all IPC files; deserves its own focused PR with a test pass.
**Context:** Every IPC handler has `const userId = getCurrentUserId()`, optional param checks, and `logAudit(userId, type, id, action, payload)`. A helper like `withUserId((userId, ...args) => { ... })` could wrap the userId retrieval. A `requireParam(value, 'name')` helper could replace the guard. Start by inventorying all patterns in `src/main/ipc/` — there are ~12 IPC files. Audit helper in `src/main/ipc/ipc-helpers.ts`.
**Effort:** M
**Priority:** P3
**Depends on:** notes-ipc-base.ts (this PR — establishes the factory pattern as a precedent).

---

### Frontend PropertyBadge / section header atoms
**What:** Extract the inline badge and section header JSX shared between `ContactPropertiesPanel.tsx` and `CompanyPropertiesPanel.tsx` into shared `<PropertyBadge>` and `<SectionHeader>` components.
**Why:** ~30 lines of near-identical badge + header JSX duplicated in both panels — any visual change must be made twice.
**Pros:** Single edit for badge/header style changes; panels shrink by ~60 lines total.
**Cons:** Wait for panels to stabilize (active development); premature extraction risks churn if the UX is still changing.
**Context:** Both panels render entity-type badges (e.g. "Investor", "Startup") and collapsible section headers with the same markup and CSS class patterns. After the enrichment proposals UX settles, extract to `src/renderer/components/crm/PropertyBadge.tsx` and `SectionHeader.tsx`. Reference: `ContactPropertiesPanel.tsx` around the badge render and section header render; `CompanyPropertiesPanel.tsx` has matching patterns.
**Effort:** S
**Priority:** P3
**Depends on:** Enrichment proposals UX to stabilize first.


---

## P2 — NoteTagger

## P2 — Partner Meeting: Drag-and-drop item reordering

### Drag-and-drop item reordering within digest sections
**What:** Allow partners to drag items within sections in the Partner Sync digest view.
**Why:** Partners want to set discussion priority within a section (e.g. put the most important New Deal first).
**Pros:** Better meeting prep UX; `partner_meeting_items.position` is already REAL (fractional indexing) so the schema supports it without migration.
**Cons:** DnD adds interaction complexity; needs a DnD library (same one as Pipeline kanban is the reference).
**Context:** `partner_meeting_items.position` is a REAL column supporting fractional indexing: insert between a and b = (a+b)/2. If positions get too close (delta < 0.001), renumber the section. `PARTNER_MEETING_ITEM_UPDATE` already accepts `position` field. Start in `src/renderer/components/partner-meeting/DigestSection.tsx`. Use the same DnD library as Pipeline kanban (`src/renderer/routes/Pipeline.tsx`) for consistency.
**Effort:** M
**Priority:** P2
**Depends on:** Partner Meeting feature (this PR).

---

## P2 — Partner Meeting: Multi-user digest conflict handling

### Last-write-wins conflict resolution for concurrent digest edits
**What:** When two partners edit the same digest item simultaneously, the last save silently wins. Before multi-user lands, partners need to coordinate out-of-band.
**Why:** Multi-user support is on the roadmap. The current implementation has no version/etag on `partner_meeting_items` so concurrent edits will silently overwrite each other.
**Pros:** Prevents data loss for distributed partner teams; sets up the foundation for real-time collaboration.
**Cons:** Optimistic locking (S effort) requires an `updated_at` check before every write; CRDT/field-level merging (L effort) requires significant architecture work.
**Context:** `partner_meeting_items` has `updated_at` but no version counter. The write path is `updateItem()` in `src/main/database/repositories/partner-meeting.repo.ts`. When multi-user lands: add `expected_updated_at` parameter to `updateItem()`, check `WHERE id = ? AND updated_at = ?`, throw if 0 rows affected (conflict), surface conflict toast in `DigestItemNotes.tsx` and `CompanyDigestItem.tsx`. CRDT approach: adopt field-level merging (last-field-write-wins per key).
**Effort:** S (optimistic lock + conflict toast) / L (CRDT field merging)
**Priority:** P2
**Depends on:** Multi-user auth system (not yet started).

---

## P3 — Partner Meeting: Transcript context indicator in ReconcileModal

### Show transcript chars matched per company card in ReconcileModal
**What:** Add a muted badge on each ReconcileModal card header showing "N chars from transcript" (or nothing if 0), so partners know why a proposal is rich or sparse without opening the full transcript.
**Why:** When a company isn't mentioned in the transcript, the LLM generates a weaker proposal based only on digest notes. Partners currently have no signal about why one card is detailed and another is thin.
**Pros:** Pure polish — no architecture change; makes reconciliation results more trustworthy and self-explanatory.
**Cons:** Adds a field to `ReconcileProposal`; slightly increases IPC payload.
**Context:** In `generateReconciliationProposals` (`src/main/services/partner-meeting-reconcile.service.ts`), after calling `extractCompanyExcerpts`, record `transcriptCharsUsed: filteredExcerpt.length`. Add `transcriptCharsUsed?: number` to `ReconcileProposal` in `src/shared/types/partner-meeting.ts`. In `ReconcileModal.tsx`, display as a muted `<span>` in the card header row: "N chars from transcript" when > 0, or "no transcript match" when 0 and a transcript was linked.
**Effort:** S
**Priority:** P3
**Depends on:** Partner Meeting reconciliation feature (this PR).

---

## P2 — Notes: Quick Switcher (Cmd+K)

### Notes quick switcher
**What:** Floating modal triggered by Cmd+K (from any route), searches notes by title and content, opens the result in the three-pane Notes view right pane.
**Why:** The Notes search bar requires navigating to the Notes route first. The quick switcher works from any route, making it the fastest path to any note.
**Pros:** Dramatically speeds up note access for users with large note collections; consistent with "Cmd+K opens search" conventions users already know.
**Cons:** Requires a global keyboard listener (can attach in App.tsx or a new provider) and a floating modal component. Notes search results need to surface from main process — reuses `NOTES_LIST` with `query` param.
**Context:** The three-pane Notes view introduces `selectedNoteId` state. The quick switcher should navigate to `/notes?note=:id` so the full three-pane view opens with the note selected. Reuse `usePicker` pattern for the search field. Register Cmd+K in App.tsx with a `useEffect`; render a `<NotesQuickSwitcher>` portal near the root.
**Effort:** M
**Priority:** P2
**Depends on:** Three-pane Notes view (this PR).

---

## P3 — Notes: Drag notes between folders

### Drag notes between folders
**What:** Drag a note card in the list pane onto a FolderSidebar item to assign that folder to the note (calls `NOTES_UPDATE` with `folderPath`).
**Why:** Currently reassigning a folder requires opening the note in the editor and using the folder picker. Drag is more direct and discoverable.
**Pros:** Faster folder management for heavy note users; natural interaction model.
**Cons:** Requires DnD library or HTML5 drag API; needs visual drop targets on FolderSidebar items and drag state on note cards. Medium complexity.
**Context:** FolderSidebar items are plain divs — add `onDragOver` / `onDrop` handlers. Note cards in `Notes.tsx` get `draggable` prop + `onDragStart` storing `note.id`. On drop, call `api.invoke(NOTES_UPDATE, id, { folderPath })` then `fetchNotes()` + `fetchFolderCounts()`.
**Effort:** M
**Priority:** P3
**Depends on:** Three-pane Notes view (this PR).

---

## P3 — Notes: Index for getFolderCounts() scalability

## P3 — Chat: Persist context selection across sessions in MeetingDetail

### Remember last-selected AI chat context per meeting
**What:** Persist the user's last-selected context option (company or contact) in the AI chat panel so it restores when they reopen the meeting.
**Why:** Currently the context chip always defaults to "This meeting" on every open. If a user consistently wants to ask cross-company questions about a given meeting, they have to re-select the context every time.
**Pros:** Small quality-of-life win; eliminates a repeat click for users who frequently use company/contact context.
**Cons:** Requires either localStorage or a new `user_preferences` DB table keyed by meeting ID. Adds state persistence complexity to what is currently a simple piece of UI state.
**Context:** The `activeContext` state lives in `ChatInterface.tsx`. On mount it defaults to `'meeting'`. To persist: store as `chat_context_<meetingId>` in localStorage, read on mount when `contextOptions` is provided. Validate that the stored context ID still exists in the current `contextOptions` before restoring (otherwise fall back to `'meeting'`).
**Effort:** S
**Priority:** P3
**Depends on:** Chat Context Switcher feature (this PR).

---

## P3 — Notes: Fix --cv-* dark mode for MeetingDetail

### Add --cv-* overrides to dark mode block in globals.css
**What:** `globals.css` defines `--cv-*` variables (e.g. `--cv-bg`, `--cv-text-primary`) used throughout `MeetingDetail.module.css`, but has no `prefers-color-scheme: dark` overrides for them — so MeetingDetail always renders with light-mode colors even in dark mode.
**Why:** NoteDetail was intentionally kept on `--color-*` (which has dark mode overrides) to avoid this. As long as `--cv-*` lacks dark overrides, MeetingDetail is permanently light-themed in dark mode.
**Pros:** Minimal effort; fixing it unblocks a full dark mode experience for the most-used view in the app.
**Cons:** Need to audit all `--cv-*` usages to ensure correct dark values.
**Context:** `globals.css` has a `@media (prefers-color-scheme: dark)` block that overrides `--color-*` variables. Add a parallel block for all `--cv-*` variables used in `MeetingDetail.module.css`. Cross-reference `src/renderer/styles/globals.css` and `src/renderer/routes/MeetingDetail.module.css` to enumerate the needed overrides.
**Effort:** S
**Priority:** P3
**Depends on:** Nothing.

---

## P3 — Notes: Denormalize sourceMeetingTitle onto Note type

### JOIN meeting title in notes.repo.ts to eliminate secondary MEETING_GET call
**What:** `NoteDetail.tsx` currently fires a secondary `api.invoke(MEETING_GET, sourceMeetingId)` IPC call to fetch the meeting title for the source meeting chip. The cleaner fix is to JOIN the `meetings` table in `notes.repo.ts` and include `sourceMeetingTitle` alongside the existing `companyName` / `contactName` denormalized fields.
**Why:** The current async-fetch approach requires a try/catch and suppresses the chip on failure — fragile if the meeting was deleted. Denormalizing the title eliminates the secondary IPC call and makes the chip render synchronously from already-loaded note data.
**Pros:** Removes async failure path; chip renders without a round-trip; consistent with how `companyName`/`contactName` are already handled; simplifies `NoteDetail.tsx`.
**Cons:** Medium effort — requires updating the SQL query, the shared `Note` type, and the `NoteDetail` component to read `note.sourceMeetingTitle` instead of fetching it. The `suppress-on-failure` catch block in `NoteDetail.tsx` can be deleted once this lands.
**Context:** In `src/main/database/repositories/notes.repo.ts`, the note SELECT query already LEFT JOINs `companies` and `contacts`. Add `LEFT JOIN meetings m ON m.id = n.source_meeting_id` and select `m.title AS source_meeting_title`. Add `sourceMeetingTitle: string | null` to the `Note` type in `src/shared/types/note.ts`. Update `NoteDetail.tsx` to read `note.sourceMeetingTitle` directly (remove the `useEffect` that calls `MEETING_GET` and the `sourceMeetingTitle` state).
**Effort:** M
**Priority:** P3
**Depends on:** Notes UI redesign PR (creates the consumer — this PR).

---

## P2 — Company Enhancement

### DropdownButton shared component + table CSS extraction
**What:** Create `src/renderer/components/common/DropdownButton.tsx` as a shared portal+click-outside dropdown base. Refactor `ColumnPicker.tsx` and `GroupByPicker.tsx` to use it. Extract shared table CSS (group headers, sort badges, add-row styles) into `src/renderer/styles/table-shared.module.css`.
**Why:** Three separate components (`ColumnPicker`, `GroupByPicker`, contact/company header context menus) duplicate the same portal+click-outside pattern. Group header styles, sort badge, and add-row styles are duplicated across `CompanyTable.module.css` and `ContactTable.module.css`.
**Pros:** Single implementation for portal+click-outside; future table features only need one file touched.
**Cons:** Refactoring `ColumnPicker` is regression-prone — it's battle-tested. CSS consolidation requires touching both table modules.
**Context:** Deferred from the "world-class CRM table" PR (multi-sort, grouping, SmartFilters, scope tabs) to reduce diff size. `GroupByPicker` was built self-contained and is the reference implementation for the refactor. Styles to extract: `.groupHeaderRow`, `.groupToggle`, `.groupChip`, `.groupCount`, `.sortBadge`, `.dataCell`, `.addRow`, `.addRowCell`, `.addRowInput`.
**Effort:** M
**Priority:** P3
**Depends on:** World-class CRM table PR merged.

### Email source in CompanyEnhanceModal
**What:** Add "From recent emails" as a third source option in `CompanyEnhanceModal` — fetches recent emails from the company's domain via Gmail, runs the same VC analysis pipeline, and creates a note.
**Why:** Partners frequently have inbound email threads with portfolio companies or prospects that contain deal context (financial updates, deck attachments, meeting follow-ups). Surfacing this alongside PDF/URL sources makes "Enhance" a complete single entry point.
**Pros:** Closes the loop on the three natural deal-info sources (file, URL, email); reuses the existing `mcp__claude_ai_Gmail__gmail_search_messages` integration and the `COMPANY_ANALYZE_FILE` pipeline.
**Cons:** Blocked on Gmail IPC integration — `gmail_search_messages` is currently MCP-only and not wired into an Electron IPC handler; requires a new `COMPANY_ENHANCE_FROM_EMAIL` channel + email extraction service.
**Context:** `CompanyEnhanceModal` source picker is in `src/renderer/components/company/PitchDeckSourceInput.tsx`. The "From emails" option would add a step for email thread selection (query by company domain or name), then pass selected thread content as `rawText` to the same `runPitchDeckAnalysis` used by the PDF/URL path. Gmail search is available via `mcp__claude_ai_Gmail__gmail_search_messages` — the IPC bridge work is the blocker. Start by wiring a `GMAIL_SEARCH` IPC channel in `src/main/ipc/` that calls the Gmail MCP tool.
**Effort:** L
**Priority:** P2
**Depends on:** Gmail IPC bridge (not yet started); `COMPANY_ANALYZE_FILE` handler (this PR).

---

## P3 — Contacts (LinkedIn Enrichment)

### Past employee index for listPastEmployeeContacts
**What:** If `listPastEmployeeContacts()` becomes slow at scale, add a generated SQLite column or a separate `contact_company_history` junction table to enable an index on the companyId field.
**Why:** The current `json_each(work_history)` query does a full table scan. At <5k contacts + in-process SQLite, it's fast enough today. A console.time log in the code will surface if it becomes a problem.
**Pros:** Enables O(log n) lookup for past employees instead of full scan.
**Cons:** Generated columns require SQLite 3.31+ (available in modern Electron). A junction table requires migration complexity and a trigger or app-level sync to keep in sync with `work_history`.
**Context:** `listPastEmployeeContacts()` in `src/main/database/repositories/contact.repo.ts`. The timing log added in the LinkedIn enrichment PR is the signal: if p99 > 50ms, add an index. Consider a `contact_work_company_ids` TEXT column with a space-separated list of companyIds, maintained on `work_history` write. Then index that column and use a LIKE query.
**Effort:** M
**Priority:** P3
**Depends on:** LinkedIn enrichment PR (this work) merged. Only worth doing if the timing log shows a problem.

---

## P2 — Contacts (LinkedIn Enrichment)

### Past employer filter in Contacts table
**What:** A "Past employer" filter in the Contacts route that finds all contacts who have a given company anywhere in their `work_history` — both by `companyId` (for Cyggie-linked companies) and by company name text (for unlinked companies).
**Why:** Reference checks and warm intro mapping — "who in my network worked at this founder's prior company?" This is the highest-leverage use of the work_history data built in the LinkedIn enrichment PR.
**Pros:** Directly enables the warm intro / reference check workflow. The `work_history` data is already there; the query is a `json_each` on the `company` text field (case-insensitive). Catches unlinked employers too.
**Cons:** Without a FTS5 index on `work_history`, this is a full table scan — fine at <5k contacts. A FTS5 index would require the notes-fts5 pattern (trigger-maintained virtual table) for production scale.
**Context:** Add as a filter chip in the Contacts toolbar (alongside existing "Type" and "Stage" filters). Query: `SELECT DISTINCT c.id FROM contacts c, json_each(c.work_history) jw WHERE lower(json_extract(jw.value, '$.company')) LIKE lower('%' || ? || '%')`. Also support filtering by companyId for the "open Sequoia → see who worked there" flow. Start in `src/renderer/routes/Contacts.tsx` and add a corresponding IPC channel `CONTACT_LIST_BY_PAST_EMPLOYER`.
**Effort:** M
**Priority:** P2
**Depends on:** LinkedIn enrichment PR (this work) merged. Past employees in Company contacts tab (this PR) is related but separate.

---

## P3 — Web Share

### File attachments in FloatingChatWidget
**What:** Allow users to attach files (images, PDFs) to questions in the floating chat widget on share pages, forwarding them to Claude as vision/document content.
**Why:** Users sharing meeting notes or memos may want to ask questions in context of an attached document (e.g., "compare this transcript to the attached term sheet"). Claude supports vision and document inputs natively.
**Pros:** Significant capability uplift for power users; Claude's multimodal API is already in use elsewhere.
**Cons:** Requires file upload to a temporary store (or base64 inlining for small files); file size limits, format validation, and security review for the upload endpoint. The floating widget's fixed-position layout needs a file chip row without breaking the pill aesthetic.
**Context:** Added in the web share redesign PR. Start in `web/components/FloatingChatWidget.tsx`. The SSE chat routes (`/api/chat`, `/api/memo-chat`, `/api/note-chat`) would need to accept an `attachments` array and forward content blocks to the Anthropic SDK `messages.create` call. The `createClaudeSSEResponse` utility in `web/lib/sse-stream.ts` currently only handles text messages — extend the `messages` param type or add a separate `contentBlocks` param.
**Effort:** L
**Priority:** P3
**Depends on:** Web share redesign PR merged.

---

## P3 — Design System

### Full oklch token migration
**What:** Migrate all remaining CSS modules from `--color-*` / `--cv-*` hex tokens to the new `--cy-*` oklch tokens in `globals.css`.
**Why:** The Company/Contact Detail redesign introduced `--cy-*` tokens (oklch warm neutrals) alongside the legacy hex tokens. Both systems coexist, which creates maintenance burden — contributors must know which system to use for which component.
**Pros:** Unified token system; consistent warm neutral palette across all views; oklch gives perceptually uniform color manipulation.
**Cons:** Touch every CSS module in the project (~40+ files). Risk of visual regressions in views not covered by the redesign.
**Context:** New tokens are in `src/renderer/styles/globals.css` under the "Cyggie Design Tokens" comment block. New components (KeyTakeawaysCard, ScorecardStrip, PipelineStepper, RecordTopBar, etc.) already use `--cy-*` with `--color-*` fallbacks. Migration path: replace `var(--color-bg)` → `var(--cy-bg)`, `var(--color-text)` → `var(--cy-text)`, etc., one CSS module at a time. Remove `--color-*` vars from `:root` when no more consumers exist.
**Effort:** M
**Priority:** P3
**Depends on:** Company Detail redesign PR merged.

---

## P3 — Developer Experience

### Storybook setup for new primitives
**What:** Set up Storybook and add stories for the new shared components: `ScorecardStrip`, `PipelineStepper`, `CollapsibleSection`, `KeyTakeawaysCard`, `Tooltip`, `RecordKebabMenu`, `RecordTopBar`, `AddTaskModal`.
**Why:** No visual testing or component documentation infrastructure exists. New primitives are designed for reuse across Company and Contact Detail — stories provide living documentation and catch visual regressions.
**Pros:** Visual component catalog; isolated development environment; catches CSS regressions before integration.
**Cons:** Storybook adds build-time dependency and config overhead (~30 min setup for Electron + Vite).
**Context:** Components live in `src/renderer/components/common/`. Each accepts simple props (no IPC dependency) making them ideal for Storybook isolation. Start with `npx storybook@latest init` in the project root, configure for Vite + React, and create one `.stories.tsx` per component.
**Effort:** M
**Priority:** P3
**Depends on:** Company Detail redesign PR merged.

---

## P2 — UI

### ContactPropertiesPanel decomposition quality bar
**What:** Ensure `ContactPropertiesPanel.tsx` (currently 1960 lines) reaches ~500 lines via full extraction of `ContactIdentityBlock`, `ContactStatusPillRow`, `ContactQuickActions`, and section components.
**Why:** The Company Detail redesign decomposed `CompanyPropertiesPanel` from 1905 → ~500 lines using extracted sub-components. ContactPropertiesPanel is even larger and should reach the same quality bar for maintainability.
**Pros:** Parity between both record-type panels; each section independently modifiable; reduced cognitive load for new contributors.
**Cons:** Contact panel has different state interactions (LinkedIn enrichment, talent pipeline, chat) — extraction requires careful prop threading.
**Context:** Shared components already exist from the Company redesign: `CollapsibleSection`, `KeyTakeawaysCard`, `ScorecardStrip`, `PipelineStepper`, `AddTaskModal`, `RecordTopBar`, `RecordKebabMenu`. Contact-specific extractions needed: `ContactIdentityBlock` (avatar, name, title, company), `ContactStatusPillRow` (contact type, talent pipeline), `ContactQuickActions` (Email, Call, Task). The `useTakeaways` hook should replace the inline KT state (lines 224-554).
**Effort:** M
**Priority:** P2
**Depends on:** Company Detail redesign PR merged.

---

## P2 — Companies

### Aliases / "Same as..." UI for user-asserted same-company links
**What:** Persist user-confirmed same-company assertions in the existing `company_aliases` table (with `alias_type = 'same_as'`) and surface a "Same as..." action on the company detail page kebab menu. Surface aliased companies in the suspected-duplicates list as a separate "user-confirmed" group above fuzzy/domain groups.
**Why:** Even with the cross-pass merge fix, fuzzy detection has a recall ceiling. Users who know two records are the same (Twitter / X, FedEx / Federal Express) currently have only the destructive merge hammer. Aliases are non-destructive — keep both records, mark them as duplicates of each other, and the merge becomes a one-click action later.
**Pros:** Closes the long-tail recall gap that fuzzy can never fully close. Reuses existing `company_aliases` schema (no migration needed). Non-destructive — the user can undo.
**Cons:** New UI surface (kebab menu action + company picker modal). ~1–2 days work.
**Context:** `company_aliases` table already exists with `(company_id, alias_type, alias_value)`. Add to record kebab menu in `CompanyHeaderCard`; picker over other companies; insert row with `alias_type = 'same_as'`. Update `listSuspectedDuplicateCompanies` to surface user-asserted same-company groups as a separate top tier (always shown, even when fuzzy/domain pass would miss).
**Effort:** M
**Priority:** P2
**Depends on:** Cross-pass dedup fix (this PR) landed.

---

## P3 — Companies

### Surface "fuzzy detection skipped" cap to the renderer
**What:** Change `listSuspectedDuplicateCompanies` return shape to `{groups, truncated, candidateCount}`; the IPC handler emits `logAppEvent('company.dedup_fuzzy_skipped', ...)` and the Companies page shows a banner ("Detection limited to most recent 5000 companies — some duplicates may be missed") when truncated.
**Why:** Today the cap-skip case logs `console.warn` only — invisible to users. If the workspace grows past 5000 ungrouped companies, dedup silently degrades.
**Pros:** No silent failures. User-actionable signal.
**Cons:** Touches IPC contract (~10 lines) + renderer banner (~20 lines) + test (~5 lines). Probably never hit in practice at the new 5000 cap.
**Context:** [Companies.tsx:474](src/renderer/routes/Companies.tsx#L474) currently destructures the IPC response as the array directly. Renderer banner: small alert above the dedup group list.
**Effort:** S
**Priority:** P3
**Depends on:** Nothing.

---

## P2 — Investment Thesis Agent (Phase 2 follow-ups)

These items were deferred from the Phase 1 Investment Thesis Agent build. Each
one is an independent extension of the agent infrastructure landed across
commits `feat(db): migrations 085-087`, `feat(agent): generic tool-use loop …`,
and `feat(agent): renderer UI`.

### Per-claim identity / `claims` table extraction
**What:** Extract claims from the memo into a dedicated `claims` table
(id, version_id, ordinal, text, category). `memo_evidence` and a new
`claim_critiques` table FK to it instead of carrying the raw `claim_text`
substring. EvidenceSidebar then looks up by stable `claim_id` instead of
fuzzy substring matching.
**Why:** Phase 1 uses fuzzy substring match, which breaks when the rendered
memo's claim text drifts even slightly from the persisted `claim_text`.
Stable claim ids enable per-claim re-verification, stale-claim flagging, and
cross-version claim tracking.
**Pros:** Unblocks per-claim re-verification (right-click "verify this"),
per-claim re-research, per-claim staleness — all currently impossible.
**Cons:** Migration + repo refactor + renderer fuzzy-match removal. ~600 lines.
The agent's `submit_memo` schema needs to be extended to emit `claim_id` (or
the post-save step needs to assign ids by ordinal).
**Context:** Phase 1 schema is in `src/main/database/migrations/085-memo-evidence.ts`.
Fuzzy lookup lives in `src/renderer/components/company/EvidenceSidebar.tsx:substringMatch()`.
The agent's output schema is `SubmitMemoInputSchema` in `src/shared/types/thesis.ts`.
**Effort:** L
**Priority:** P2
**Depends on:** Phase 1 stress-test agent merged (✅).

---

### `agent_runs` TTL pruning
**What:** On startup, after orphan-GC, prune `agent_runs` (and dependent
`agent_run_events`) rows older than a configurable TTL (default 90 days).
**Why:** Tables grow unbounded. Each run writes 1 agent_runs row + ~20
agent_run_events rows; at 30 runs/week that's ~3000 events/week. SQLite
handles this fine for years, but the `/dev/agent-runs` view will get noisier.
**Pros:** ~15 lines: a `DELETE FROM agent_runs WHERE datetime(started_at) < datetime('now', '-N days')`
right after the orphan-GC call in `src/main/database/connection.ts`. Cascade
on `agent_run_events.run_id` already drops events.
**Cons:** Loses long-tail historical observability — but the data is for
debugging, not analytics.
**Context:** Add `agent.runRetentionDays` setting (default 90). Read at startup
inside `getDatabase()`. Log how many rows were pruned for observability.
**Effort:** S
**Priority:** P2
**Depends on:** Phase 1 (✅).

---

### Push-notification digest of stress-test concerns
**What:** Daily/weekly background job that scans the most recent agent_runs
across the portfolio for `cap_exceeded` runs and high-severity critique
evidence rows added in the past N days. Emits a push notification: "3 of your
companies have new high-severity concerns from overnight research."
**Why:** Surfaces the agent's adversarial work proactively. Today the user
has to remember to click Stress-test on each company they care about.
**Pros:** High-leverage UX — the agent works for the user instead of waiting
to be asked. Reuses existing `notification:start-recording` IPC pattern.
**Cons:** Needs a background scheduler (not yet present in main); decisions
around quiet hours, dedup ("seen this concern already"), severity threshold.
**Context:** New scheduler module under `src/main/services/`. Read recent runs
from `agent_runs`, recent evidence from `memo_evidence WHERE is_critique=1
AND severity='high'`. Bind to electron's `Notification` API; the renderer
already has `NotificationPermissionInit`.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 (✅), background scheduler (none today).

---

### Side-by-side memo diff view
**What:** A two-column "what changed" view comparing two `investment_memo_versions`
rows. Highlights inserted / removed / modified text at the section level, with
hover cards showing the agent's reasoning if the version was produced by an
agent run.
**Why:** Users today can flip between versions in the dropdown but can't see
WHAT changed at a glance. Especially valuable post-stress-test (compare
original vs. critiqued).
**Pros:** Pure UI feature; existing version data is sufficient. ~250 lines:
new route `/company/:id/memo-diff?from=A&to=B` plus a diff renderer.
**Cons:** Markdown diffing with section awareness is non-trivial; off-the-shelf
diff libs work at line/word level, not section level.
**Context:** Versions live in `investment_memo_versions`; agent reasoning
trace lives in `agent_run_events` (link via `agent_runs.result_version_id`).
Existing version dropdown is in `src/renderer/components/company/CompanyMemo.tsx`.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 (✅).

---

### Anthropic hosted web_search swap option
**What:** When Anthropic's hosted `web_search_20250305` tool stabilizes,
add it as an alternative backend in `src/main/services/exa-research.ts`,
controlled by an `agent.webSearchProvider` setting (`exa` | `anthropic`).
**Why:** Anthropic's tool returns model-friendly snippets without an extra
API key + dependency. Exa is currently the right pick because we already
have it; that may change.
**Pros:** Zero infra (no Exa key needed for users who don't already have one).
Anthropic tool quality is improving fast.
**Cons:** Per-search cost is similar; URL allowlist still needs to apply at
`web_fetch` boundary regardless of search provider; dual-backend code path
is a maintenance tax until one wins.
**Context:** `agentWebSearch` and `agentWebFetch` in `src/main/services/exa-research.ts`
are the swap points. The Anthropic Web Search tool is exposed via the
`tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: N }]`
parameter to `messages.create` — would replace the Zod-defined `web_search`
tool with a hosted one. URL allowlist would live as a wrapper on the agent's
`tool_result` post-processing rather than at fetch time.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 (✅), Anthropic GA of the hosted web_search tool.

---

### A/B prompt experimentation
**What:** Variant table for system prompts (`agent_prompt_variants`: id, kind,
label, content, traffic_weight). Agent loop reads the current variant per run
and records `variant_id` on the `agent_runs` row so post-hoc cost/quality
analysis can compare variants.
**Why:** Stress-test prompt engineering is going to evolve. Without runtime
variant tracking, every prompt iteration is a global change with no way to
compare before/after rigorously.
**Pros:** Unlocks principled prompt iteration. ~200 lines: new table, repo,
prompt-resolver, settings UI for variants.
**Cons:** Variants without enough N are noisy. Probably don't need this until
the agent is in regular use.
**Context:** Today prompts live in `src/main/llm/agents/prompts/*.md` imported
via `?raw`. Variant lookup would replace the static import with a DB read at
the start of each run. Add a column to `agent_runs` for `prompt_variant_id`.
The existing `agent_runs.kind` already namespaces variants by use-case.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 (✅).

---

## P2/P3 — Investment Thesis Agent (memo-context expansion follow-ups)

These items were deferred from the niche-targeted query + comprehensive
context expansion landed in `feat(memo-gen): niche-targeted research +
comprehensive context`. Each is an independent extension.

### LLM-driven niche extraction across all summaries
**What:** Pre-call the LLM (Haiku, cheap) to write a 1-sentence "what does this
company do" summary from ALL meeting summaries, and use that as the
`nicheSignal` instead of the first 500 chars of the most recent summary.
**Why:** When the most recent meeting is a follow-up that doesn't restate the
pitch (e.g., "Jane sent over the updated financials"), the first-500-chars
heuristic produces a weak niche query. An LLM-derived synthesis across all
summaries captures the company's pitch more reliably.
**Pros:** Better Exa neural results → better Competition + Market sections in
the memo. Cheap (Haiku is ~$1/M tokens).
**Cons:** Adds a 1–2s LLM call to the fast path. Adds another moving part.
**Context:** Replace the niche-signal derivation in
`src/main/ipc/investment-memo.ipc.ts` (currently `summaries[0]?.content?.slice(0, 500)`)
with a call to a new `summarizeNiche(summaries: Array<{title, date, content}>)`
service. Cache by company_id + summary version hash so re-runs don't re-pay.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 niche-targeted memo gen (✅).

---

### Direct LinkedIn-URL fetch for founders with cached URLs
**What:** When a contact has `linkedinUrl` set, skip the Exa search and
`web_fetch` the URL directly. The agent's `web_fetch` tool already exists.
**Why:** Saves an Exa search ($) and gets the actual profile content instead
of search-result snippets. More accurate Team-section content.
**Pros:** Cheaper + more accurate. ~30 lines: branch in the IPC handler when
`founder.linkedinUrl` is set; pass URLs to a new `searchCompanyContextWithFetch`
that mixes search + fetch.
**Cons:** `web_fetch` is currently agent-only; would need to expose at the
service layer too. URL-allowlist check still applies (LinkedIn is public so
this is fine).
**Context:** Founders are pulled from `linkedContacts` in
`src/main/ipc/investment-memo.ipc.ts`. Each `CompanyContactRef` has
`linkedinUrl: string | null`. Add a parallel "fetch this URL" path inside
`searchCompanyContext` that runs alongside the search queries.
**Effort:** S
**Priority:** P3
**Depends on:** Phase 1 (✅).

---

### Per-meeting relevance ranking (cap to top N)
**What:** When a company has 20+ meetings, surface only the top 5 most-relevant
by recency × topical-fit instead of including all (with the existing
truncation). Reduces context cost on long-running deals.
**Why:** A deeply-engaged portfolio company can have 30+ meetings linked. The
existing pipeline truncates each to 8k chars but still includes all of them.
Beyond ~20 meetings the value/token ratio degrades.
**Pros:** Lower token cost + cleaner memo focus on relevant signal.
**Cons:** "Relevance" is fuzzy; risk of ranking algorithm picking the wrong
meetings. Probably needs an LLM-driven or semantic-similarity ranker.
**Context:** Affects the meeting-loading loop in `INVESTMENT_MEMO_GENERATE`.
Today: `companyRepo.listCompanyMeetingSummaryPaths(companyId)` returns ALL
matching meetings. New: rank, take top 5, pass forward.
**Effort:** L
**Priority:** P3
**Depends on:** Phase 1 (✅), some kind of ranker (LLM call or embedding similarity).

---

### Auto-detect founder career-history patterns in keyTakeaways
**What:** Surface "{founder} was [role] at [Co]" sentences in a structured
Team-section seed block (separate from the contactKeyTakeaways block) so the
model is less likely to hallucinate or omit experience.
**Why:** Team section quality is a frequent partner-meeting question. Today
the model sees a free-text keyTakeaways blob and may skim or restructure it.
A structured "career_history" array forces attention.
**Pros:** Better Team section. Small prompt addition.
**Cons:** Pattern extraction is brittle (regex against natural language);
better as an LLM call but that adds cost.
**Context:** The `contact.keyTakeaways` field is rendered as-is into the
prompt today. New: pre-process via a small NLP/regex step OR an LLM
extraction call to produce a structured `careerHistory: Array<{role, company, dates?}>`
which is then formatted into the prompt.
**Effort:** M
**Priority:** P3
**Depends on:** Phase 1 (✅).

---

### `MemoGenerateInput` shape cleanup
**What:** Group sources into `sources: { meetings, transcripts, companyNotes,
contactNotes, contactKeyTakeaways, emails, files, externalResearch }` instead
of 8+ flat fields. Pure refactor.
**Why:** `MemoGenerateInput` has accreted to 12+ flat fields after the memo-
context expansion. Adding a new source means another field; readability
degrades. Grouping by category makes intent obvious and makes the next
addition a one-liner.
**Pros:** Cleaner type, easier to extend. Net diff is small (~50 lines, mostly
moving fields and updating call sites).
**Cons:** Touches a stable file; risks breaking the existing IPC handler's
`generateMemo` call. Tests already cover the call shape.
**Context:** `MemoGenerateInput` lives in `src/main/llm/memo-generator.ts`.
Single caller is `src/main/ipc/investment-memo.ipc.ts`. Group fields, update
the call site, update memo-generator's prompt builder (which reads the fields
inline).
**Effort:** S
**Priority:** P2
**Depends on:** Phase 1 (✅).

---

### Error telemetry forwarder
**What:** Forward errors caught by `src/renderer/components/common/ErrorBoundary.tsx`
to a real telemetry sink — Sentry, Datadog, or a main-process file logger over IPC.
Today `componentDidCatch` only calls `console.error`, which is invisible unless the
user happens to have devtools open.
**Why:** This app is being actively iterated on. Bugs like the chat-panel
white-screen would surface immediately if production crashes were captured.
Without it, we depend on users noticing, reproducing, and reporting.
**Pros:** Real-world failure modes surface without user effort; faster debug
cycles; existing error boundary is the natural hook point.
**Cons:** Greenfield infra in this app (no telemetry today); adds an external
dependency or local logging surface; privacy review needed for any data
leaving the user's machine.
**Context:** `ErrorBoundary` was extracted alongside the chat-panel pop-out fix.
The `componentDidCatch` method is the single hook point — any sink we pick plugs
in there. Simplest stack: write to a JSON file in `app.getPath('logs')` via a
new IPC channel; user can opt in to sharing.
**Effort:** M
**Priority:** P3
**Depends on:** Decision on telemetry stack.

---

## P1 — Stress-test (Phase 2 follow-ups)

### Apply selected findings → rewrite memo
**What:** Add checkboxes per concern in the StressTestReportViewer. "Apply N selected" triggers either (a) deterministic append to memo's Risks section or (b) a new memo-rewriter agent run.
**Why:** Closes the loop on the new product model. Phase 1 made stress-test produce findings without touching the memo; Phase 2 lets the user opt-in concern-by-concern to incorporate findings into a new memo version.
**Pros:** Completes the "review → incorporate" workflow; preserves analyst control.
**Cons:** (a) is fast/cheap but loses agent-level rewriting; (b) introduces a new agent type + doubles cost per stress-test+apply cycle.
**Context:** Selected-state lives on the viewer; new memo version is saved by either programmatic append (simpler) or a memo-rewriter agent (richer). Decide on mechanism after Phase 1 dogfooding. See `src/renderer/components/company/StressTestReportViewer.tsx` for the viewer to extend.
**Effort:** M (deterministic) or L (agent-driven)
**Priority:** P1
**Depends on:** Phase 1 shipped + a week of real usage to inform the mechanism choice.

---

## P2 — Stress-test

### Richer report history surface in subpanel
**What:** Extend `StressTestReportsSubpanel` with sort (by recency / cost / concern count), filter (by recommendation), search, and virtualization for 50+ rows.
**Why:** Phase 1 ships a basic list; once users have many reports per memo, scanning gets hard.
**Pros:** Scales the discovery surface; small UX cost.
**Cons:** Virtualization adds dependency weight if memos with >50 reports are rare.
**Context:** Current subpanel at `src/renderer/components/company/StressTestReportsSubpanel.tsx`. `listReportsForMemo` already caps at 50; extend repo signature when pagination lands.
**Effort:** M
**Priority:** P2
**Depends on:** Real usage showing the list growing beyond comfortable scan length.

---

## P2 — Stress-test

## P2 — Stress-test

### Eval suite for stress-test prompt
**What:** Build a small golden-set evaluator: 5 memos with known weak claims, run the rewritten stress-test prompt against each, assert recommendation + concern count + at least one expected finding per memo.
**Why:** Phase 1 ships a substantial prompt rewrite. No eval harness exists. A small golden set protects against future prompt regressions.
**Pros:** Catches prompt-quality regressions in CI.
**Cons:** Building + maintaining the golden set takes effort; LLM evals are flaky by nature.
**Context:** No existing `/evals` infrastructure in the repo. Build the harness alongside the first eval pass. The 5 memos can be synthetic or anonymized real memos. Compare LLM judge or rule-based assertions.
**Effort:** L
**Priority:** P2
**Depends on:** Phase 1 dogfooding to identify which dimensions matter most.

---

## P3 — Stress-test

### "Compare with prior report" toggle
**What:** When a memo has ≥2 stress-test reports, show a diff view in the viewer (concerns that appeared/disappeared since the prior run).
**Why:** Reveals whether the agent's view shifts when re-run; lets the analyst see what changed (e.g., new evidence appeared).
**Pros:** Reveals agent variance and tracks resolution of past concerns.
**Cons:** Concern matching across runs is fuzzy — no stable ids.
**Context:** Reports table has `memo_id` + `created_at`; query the prior report; concern-match by approximate string similarity on `claim`.
**Effort:** M
**Priority:** P3

---

## P3 — Stress-test

### Inline claim quoting / jump-to-claim
**What:** For each claim-level flag in the viewer, add a "Jump to claim" link that scrolls the underlying memo to the highlighted claim text.
**Why:** Connects findings to the analyst's prose; reduces context-switching.
**Pros:** Tight feedback loop.
**Cons:** Claim-matching against memo prose is fuzzy; broken links degrade trust.
**Context:** TipTap `CritiqueHighlight` extension already finds claim text in the memo. Use it as the anchor.
**Effort:** S
**Priority:** P3
**Depends on:** Stable claim-text matching.

---

## P3 — Stress-test

### Cost-per-concern stat in run summary
**What:** Display `$X.XX / concern` in the viewer's run footer.
**Why:** Quality-vs-cost metric the user can track over time.
**Pros:** Trivial to compute; surfaces a useful efficiency stat.
**Cons:** Concerns aren't all equal value; metric is rough.
**Context:** `report.costEstimateUsd / report.concerns.length` in `StressTestReportViewer`'s footer.
**Effort:** S
**Priority:** P3

---

## P3 — Stress-test

### Recommendation icon next to Stress-test button
**What:** Show a small recommendation pill next to the Stress-test button in the Memo tab toolbar, indicating the latest report's verdict (e.g., "🟡 caveats").
**Why:** At-a-glance latest verdict without opening anything.
**Pros:** Single source of truth for "what does the most recent stress-test say".
**Cons:** Adds clutter to the toolbar.
**Context:** Read latest report via `listReportsForMemo(memoId).at(0)` on Memo tab mount.
**Effort:** S
**Priority:** P3

---

## P3 — Stress-test

### Migrate legacy memo-version stress-tests into reports table
**What:** Backfill: scan `investment_memo_versions WHERE change_note='Stress-tested by research agent'`, parse Devil's Advocate section + inline evidence, create `stress_test_reports` rows.
**Why:** Today's legacy stress-test data lives in memo versions; new runs live in `stress_test_reports`. The bifurcation makes report history incomplete.
**Pros:** Unifies stress-test history across the old and new product models.
**Cons:** Parsing legacy markdown is brittle; legacy data may not have all the structured fields the new schema requires.
**Context:** Phase 1 deliberately left legacy memo versions in place; users can still browse them via the version dropdown. This TODO is for if/when we want a unified view.
**Effort:** M
**Priority:** P3

---

## P3 — Memo / Stress-test (Quality)

### Programmatic dimension-labeling validator for memo + stress-test bullets
**What:** Add a post-processor to the `submit_section` handler (memo-producer) and `submit_review` handler (stress-test) that scans Investment Thesis / Risks / concerns bullets for at least one framework dimension keyword (Tenacious, Evolving, Authentic, Magnetic, Asymmetric Upside, Increasing Marginal Returns, Compounding Defensibility, etc.). Bullets without a dimension label get auto-rejected with a retry prompt back to the agent.
**Why:** Dimension labeling is currently enforced via prompt instruction only. After ~2 weeks of real usage we'll know whether the agent consistently complies. If it drifts, a post-processor turns the rule into an enforceable invariant.
**Pros:** Hard guarantee on output structure; analyst can trust dimension-labeling without spot-checking; enables downstream aggregations ("how often does TEAM-Authentic show up as a strength?").
**Cons:** Requires defining keyword sets per dimension; agent-retry loops add latency and tokens; false-positives risk blocking legitimate phrasing.
**Context:** Current enforcement is prose in `src/main/llm/agents/prompts/memo-producer.system.md` and `src/main/llm/agents/prompts/thesis-stress-test.system.md`. Tool handlers (`submit_section`, `submit_review`) do Zod shape-validation but not body-content validation. Hook in at body-content level. Source of truth for dimension keywords: `src/main/llm/agents/prompts/investment-criteria.md`.
**Effort:** S–M
**Priority:** P3
**Depends on:** Investment-criteria PR merged + ~2 weeks of real usage to observe whether enforcement is needed.

---

### Prompt-eval golden-output harness
**What:** Test suite that generates a memo + stress-test for ~5 canonical anonymized company fixtures and compares against pinned reference outputs. Flags substantive drift (lost section, recommendation flipped, missing dimension labeling). Runs on every prompt-file change.
**Why:** Prompt edits today have no automated quality signal. The unit tests in `src/tests/prompt-substitution.test.ts` catch substitution leaks only — they don't catch semantic regressions from prompt prose changes.
**Pros:** Confidence to iterate on prompts; catches regressions before merge; serves as living documentation of expected output.
**Cons:** Real LLM calls in CI are slow + costly (mocking loses fidelity); fixture maintenance is real work; LLM "golden outputs" are inherently fuzzy → flake risk.
**Context:** No existing prompt-eval infrastructure. Would need: anonymized company fixtures, snapshot comparison logic, "substantive drift" criteria, CI flake policy. Likely starts as a manual `bun run eval` script before CI integration. Size against actual prompt-change frequency — worth it if prompts change weekly, less so if monthly.
**Effort:** L
**Priority:** P3
**Depends on:** Nothing technical.

---

## P3 — CRM / Properties panels

### Widen `ContactType` union to `string`
**What:** Change `ContactType = 'investor' | 'founder' | 'operator' | 'lp'` in `src/shared/types/contact.ts` to `string` (or `ContactType | (string & {})` to preserve autocomplete on the canonical four). Audit the ~5 files that reference the type for narrow-cast assumptions.
**Why:** After removing the `VALID_CONTACT_TYPES` whitelist from `contact.repo.ts`, custom values flow through correctly at runtime — but the `as ContactType` casts at L193 (and equivalents) are now lying. Type narrows that depend on the four-value union (e.g. exhaustive switch statements) will silently misbehave on custom values.
**Pros:** Type system matches runtime reality; safer refactors; prevents future bugs where developers write code assuming the four-value invariant.
**Cons:** Cascades into 4–5 files (contactColumns.ts, ContactTable.tsx, Contacts.tsx, contact.repo.ts, contact.ts). Some hardcoded `=== 'founder'` / `=== 'investor'` comparisons are fine to keep narrow — those are intentional behavioral filters for built-in types.
**Context:** The `as ContactType` cast already lies for `talentPipeline`-equivalents (same pattern: narrow type, no runtime validation). When this comes up again, pick one of: (a) widen the union to `string`, accept loss of literal-narrowing; (b) introduce a separate `BuiltInContactType` union for the four canonical values and keep `ContactType = string`; (c) use the template-literal trick `ContactType | (string & {})` to preserve autocomplete suggestions on the four canonical values.
**Effort:** S
**Priority:** P3
**Depends on:** Nothing.

---

### Cross-field option-name detection
**What:** When the user adds a new option via "+ Add option" on a dropdown field, fuzzy-match the typed value against existing options on *other* select/multiselect fields for the same entity. If a match is found (e.g. user types "candidate" on the Type field but "Internal Candidate" already exists on Talent Pipeline), show a modal: "Did you mean to set Talent Pipeline to 'Internal Candidate' instead?" with Redirect / Add Anyway / Cancel buttons.
**Why:** A user reported routing confusion — they typed "candidate" on Type but the value they wanted was the existing "Internal Candidate" option in Talent Pipeline. The cross-field nudge would catch this UX mistake.
**Pros:** Smart UX that catches an entire class of "wrong dropdown" misclicks; reuses existing `jaroWinkler` fuzzy match in `src/main/utils/`; once built, can extend to multiselects + custom fields uniformly.
**Cons:** Speculative — there's exactly one anecdotal user report and the actual cause turned out to be the silent-validation bug (now fixed). The user's example case ("candidate" vs "Internal Candidate") needs a substring/word match in addition to JW (JW alone scores ~0.5 on that pair and would miss it). New modal component, ~80 lines of panel wiring, and `jaroWinkler` needs to move from `src/main/utils/` to `src/shared/utils/` so the renderer can use it.
**Context:** Cut from the CEO-reviewed plan after we found the real root cause (hardcoded `VALID_CONTACT_TYPES` whitelist) was the silent-failure source, not cross-field routing. Wait for a second recurrence of the wrong-field pattern before building. Implementation sketch (from the plan): hybrid match (word-boundary substring with min length 4 OR Jaro-Winkler ≥ 0.85) across all select/multiselect fields on the entity, modal owns the resolve promise, three outcomes (redirect / add / cancel).
**Effort:** M
**Priority:** P3
**Depends on:** Move `src/main/utils/jaroWinkler.ts` → `src/shared/utils/jaroWinkler.ts` first (update 6 imports).

---

### Audit company-panel chip auto-pin
**What:** Review `CompanyPropertiesPanel.tsx` line 380 — currently always pins `entityType`, `pipelineStage`, `priority`, `round` at the top of the panel regardless of user pin preferences. Confirm whether any of these duplicate values already shown in the corresponding section row (the same redundancy that prompted the Talent Pipeline auto-pin removal on the contact panel).
**Why:** Contact panel previously auto-pinned `talentPipeline` whenever it had a value, producing a stray chip the user explicitly didn't want (since the value was already visible in the Relationship section). Company panel may have the same anti-pattern, just for four different fields.
**Pros:** Consistency with contact panel; reduces visual noise; respects user pin preferences uniformly.
**Cons:** Company chip-pinning was likely deliberate (these are core identifying fields). Removing without user feedback could surprise people. Touch only if the user reports duplication or asks for it.
**Context:** Contact panel previously had `talentPipelineChipIds = contact.talentPipeline ? ['talentPipeline'] : []` at L368 — removed in the same PR that fixed the silent-validation bug. Company panel's `allChipIds` at L380 unconditionally pins 4 fields. The fix mirrors the contact change: drop the always-pinned IDs from `allChipIds`, let users pin manually via the existing affordance.
**Effort:** S
**Priority:** P3
**Depends on:** User confirmation that the chips feel duplicative.

---

### Migrate other ad-hoc inline-error states to `useTimedError`
**What:** Grep the renderer for `useState<string | null>(null)` paired with `setTimeout`-based clear patterns, and migrate them to the shared `useTimedError` hook (`src/renderer/hooks/useTimedError.ts`).
**Why:** The same pattern was duplicated across `ContactPropertiesPanel.metaSaveError`, `CompanyPropertiesPanel.nameError`, `CompanyPropertiesPanel.deleteError`, `useCellClipboard.showToast`, plus the new `optionError` in 3 panels. The hook is now in place — the remaining ad-hoc copies should converge on it for consistency.
**Pros:** DRY; consistent error-clear behavior across the app; simplifies any future "global toast" migration since all sites already speak the `useTimedError` API.
**Cons:** Touches code that currently works fine, with no automated test coverage on most of the migrated call sites. Risk of typo regressions. Best paired with a smoke test per migrated component.
**Context:** `useTimedError` lives at [src/renderer/hooks/useTimedError.ts](src/renderer/hooks/useTimedError.ts). API: `const err = useTimedError(autoClearMs?)` → `err.error`, `err.show(msg)`, `err.clear()`. Already used by `ContactPropertiesPanel` (metaSaveError + optionError), `CompanyPropertiesPanel` (nameError + deleteError + optionError), `Pipeline` (optionError). Grep targets: `useState<string \\| null>(null)` AND `setTimeout` in the same file.
**Effort:** M
**Priority:** P3
**Depends on:** Nothing.

---

### Audit other duplicated CRM input/cell components
**What:** Search for components that duplicate behavior already covered by `crm/` shared components (e.g. `ChipSelect`, `AddOptionInlineInput`, `PropertyRow`, `TagPicker`). Likely candidates: multiselect cells in `Pipeline.tsx`, table cells in `ContactTable.tsx` / `CompanyTable.tsx`, tag/chip displays in misc components.
**Why:** `ChipDropdownCell` in `Pipeline.tsx` (consolidated into `ChipSelect variant='cell'` in the silent-failure-fix PR) was a known duplicate that carried its own silent-failure bug for years. Other duplicates likely exist and will silently miss out on fixes/improvements to the shared components (error handling, commit-on-blur, etc.).
**Pros:** Fixes/improvements to shared CRM components propagate uniformly; DRY; reduces visual inconsistency.
**Cons:** Visual variants are real — `ChipSelect`'s inline vs cell modes already required a `variant` prop. More variants may bloat the shared component. Some duplicates exist for good reason (different interaction model, different style requirements).
**Context:** Start with grep for `addCustomFieldOption(` outside `ChipSelect.tsx` to find places that have their own "add option" UI. Also grep for `AddOptionInlineInput` direct callers to find what's still wiring the input by hand. Existing shared components: [src/renderer/components/crm/ChipSelect.tsx](src/renderer/components/crm/ChipSelect.tsx), [AddOptionInlineInput.tsx](src/renderer/components/crm/AddOptionInlineInput.tsx), [PropertyRow.tsx](src/renderer/components/crm/PropertyRow.tsx), [TagPicker.tsx](src/renderer/components/crm/TagPicker.tsx).
**Effort:** M
**Priority:** P3
**Depends on:** Nothing.

---

## P2 — Security (recurring)

### Re-run markdown HTML survey after Claude/OpenAI model upgrades
**What:** Run [scripts/survey-markdown-html.ts](scripts/survey-markdown-html.ts) against recent summaries after any Anthropic or OpenAI model version bump in the codebase. If new HTML tags appear in the survey output, add them to the schema in [src/renderer/lib/markdown-sanitize.ts](src/renderer/lib/markdown-sanitize.ts).
**Why:** AI model versions sometimes change the HTML they emit (e.g., Claude 5.x adding `<thinking>` or new collapse syntax). If the sanitize schema falls out of sync, summaries silently lose formatting.
**Pros:** Catches schema drift before users notice missing formatting. ~5-minute task per model bump.
**Cons:** Recurring TODO; requires discipline to actually run after model bumps. Running the script also requires `npm rebuild better-sqlite3` against system Node before invocation, and rebuilding back for Electron afterward (the project's npm `test` script already does this dance).
**Context:** PR1 calibrated the schema by sampling real summaries (decision 2A in the security plan review — sampled 195 strings, found `br`, `u`, `img`, `sup`). The survey script is committed alongside the schema; this TODO is the operational follow-up. Schema lives at [src/renderer/lib/markdown-sanitize.ts](src/renderer/lib/markdown-sanitize.ts). When you re-run, look for any tag in the output that is NOT in `defaultSchema.tagNames` from `hast-util-sanitize` — that's what needs to be added.
**Effort:** XS (per run)
**Priority:** P2 (recurring on model bump)
**Depends on:** Nothing.

---

## P2 — Security

### SETTINGS_PICK_AND_SET_FOLDER channel for trusted folder-typed setting writes
**What:** Add a new IPC channel that wraps `dialog.showOpenDialog({properties: ['openDirectory']})` + `SETTINGS_SET` for any setting that holds a directory path. Renderer triggers a picker (no path arg from renderer); main owns the path-source guarantee.
**Why:** PR2's `APP_OPEN_USER_FOLDER` validates via `isDirectory()` + existence, but an XSS payload can still write `/etc` (a valid directory) via `SETTINGS_SET('companyLocalFilesRoot', '/etc')` and then trigger the open. The proper fix is to disallow renderer-arbitrary-string writes to folder settings entirely.
**Pros:** Closes the residual capability hole. Pairs naturally with PR2's capability-flow philosophy. Tiny: one channel + handler.
**Cons:** Need to identify every folder-typed setting (audit) and replace renderer-side `SETTINGS_SET('folderKey', value)` calls with the new channel. Probably 2-3 call sites; main checks: any setting key matching `*Root`, `*Path`, `*Dir` should be folder-typed.
**Context:** PR2 §15 plan explicitly defers this; current validation (`isDirectory + exists`) is a cheap defense that catches the obvious cases. The trusted-picker fix is the architectural correct answer. After this lands, the `isDirectory` check in `APP_OPEN_USER_FOLDER` can stay as belt-and-suspenders or be removed.
**Effort:** S
**Priority:** P2
**Depends on:** PR2 merged.

---

## P3 — Security

### LinkedIn windows: audit + flip sandbox: true
**What:** Audit the LinkedIn login window ([src/main/ipc/contacts.ipc.ts:332](src/main/ipc/contacts.ipc.ts#L332)) and LinkedIn enrichment scraper ([src/main/services/linkedin-enrichment.service.ts:117](src/main/services/linkedin-enrichment.service.ts#L117)) for sandbox compatibility. Flip `sandbox: true` once smoke tests confirm enrichment scraping still works.
**Why:** Both windows load untrusted external linkedin.com content. Sandbox is the right shape for that case. PR3b deferred them because enrichment does DOM scraping that could surprise under sandbox.
**Pros:** Completes the BrowserWindow hardening. No preload to break (these windows have no preload binding).
**Cons:** Enrichment scraping may rely on a capability sandbox restricts (e.g., reading arbitrary cookies, accessing certain DOM APIs). Needs end-to-end smoke of contact-enrichment-from-LinkedIn flows.
**Context:** PR3b §17 plan covered the two main+popout windows but explicitly deferred LinkedIn per security plan review decision 2C. The audit during planning showed both windows have `sandbox: false` (defaulted; explicitly unset). Static analysis says safe to flip; the manual smoke is the gate.
**Effort:** S
**Priority:** P3
**Depends on:** PR3b merged.

---

## P2 — CRM ingestion (follow-ups from migration 098 / 0010_sturdy_red_shift)

### Mobile group-event toggle (writes deferred until Phase 1.5 sync agent)
**What:** Add `PATCH /meetings/:id/group-event` endpoint on the gateway; wire a toggle on the mobile meeting detail screen. Use `writeWithSync` once it's available end-to-end so the desktop SQLite mirror picks up the change via the outbox/lamport pipeline.
**Why:** Mobile is read-only for the group-event flag in V1 — the banner says "Toggle from desktop". Bidirectional sync infrastructure exists at the table level (migrations 096 `lamport-on-owned-tables`, 097 `sync-outbox-state`) but the agent isn't shipped end-to-end yet. Once it is, mobile can write.
**Pros:** Closes a UX paper cut; matches the desktop affordance.
**Cons:** Cannot ship until the sync agent round-trips writes back to SQLite. Until then any mobile-side PATCH would diverge from the desktop view.
**Context:** Plan file `/Users/sandersoncass/.claude/plans/occasionally-there-will-be-resilient-anchor.md`. Gateway `GET /meetings/:id` already returns `isGroupEvent`. After sync agent ships: replace the banner subtext "Toggle from desktop" with a switch that calls the new PATCH endpoint; sync agent replays the write to SQLite. IPC channel `MEETING_SET_GROUP_EVENT` already does the desktop-side write and emits an audit row.
**Effort:** S
**Priority:** P2
**Depends on:** Phase 1.5 bidirectional sync agent.

### Stale calendar payload in MEETING_PREPARE existing-meeting branch
**What:** Reconcile the fresh calendar `attendees` / `attendeeEmails` parameters against the stored values in the `MEETING_PREPARE` existing-meeting branch ([src/main/ipc/meeting.ipc.ts:371](src/main/ipc/meeting.ipc.ts#L371)). When they differ, call `meetingRepo.updateMeeting(...)` which triggers the `MEETING_UPDATE`-style auto-flag recompute + gated `syncContactsFromAttendees`.
**Why:** Migration 098 / plan Part 2 removed the redundant `syncContactsFromAttendees` call from that branch. That call was masking a separate latent bug: the existing-meeting branch ignores the fresh calendar payload entirely, so mid-week calendar invitee changes go silently un-applied until something else triggers `MEETING_UPDATE`. The redundant sync used to paper over this by re-running upserts every poll.
**Pros:** Closes the symmetric gap left by Part 2. Mid-week invitee changes get propagated.
**Cons:** Touches a code path the 098 PR deliberately simplified; needs a targeted test for the diff-detect branch.
**Context:** Discovered during plan-eng-review Section 1 (Issue 2). Captured here per user decision to ship 098 first.
**Effort:** S
**Priority:** P2
**Depends on:** Migration 098 / `0010_sturdy_red_shift` merged.

---

## P3 — CRM ingestion

### Tombstone restore UI (optional, surface if first complaint arrives)
**What:** Add a "Show deleted contacts" affordance on the contacts list page with a Restore button that re-creates the contact (which clears the tombstone via the existing `createContact` path).
**Why:** Today, restore is implicit — the user re-creates the contact manually and the tombstone clears automatically. Works fine for a one-off but has no UI surface for "what have I deleted recently?" or "restore many at once".
**Pros:** Closes the reversibility loop on user-initiated deletions; surfaces what the tombstone table actually holds.
**Cons:** Pure new UI work; no backend changes needed. Backlog until someone complains.
**Context:** `contact_tombstones` table from migration 098 is per-email global, indexed on `email`. The list query is one row per tombstoned email + a `Restore` button that calls `CONTACT_CREATE` with that email; the existing `createContact` end-of-function already issues the `DELETE FROM contact_tombstones`.
**Effort:** S
**Priority:** P3
**Depends on:** Nothing.

---

## P3 — Mobile UX

### Attendee → Add-to-contacts CTA
**What:** Tap a non-matched attendee chip on the mobile meeting detail (the dimmed ones with no `contactId`) → open a prefilled new-contact sheet populated with the attendee name + email from the calendar invite.
**Why:** Today these chips render dimmed and inert. The user can see "we don't know this person" but can't act on it without leaving the screen. This closes the loop so an unknown attendee turns into a one-tap action to add them.
**Pros:** High-value UX — directly addresses the most common follow-up from seeing a meeting's attendees.
**Cons:** Needs a mobile create-contact form first (verify it exists on the Contacts tab before scheduling); minor sheet/modal plumbing.
**Context:** Added during the attendee-chips PR. The `AttendeeContact` shape on `MeetingDetail` already carries `{ name, email }` for unmatched attendees, so the prefill is straightforward once the form exists.
**Effort:** S
**Priority:** P3
**Depends on:** Mobile new-contact form on the Contacts tab.
