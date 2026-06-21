# TODOS

## Memo — accept/reject diff preview before persisting ("living memo")

**What:** When incorporating new material (calls/notes/emails) into an existing memo,
show the proposed per-section changes as a diff the user approves/rejects BEFORE a new
version is written, instead of the current persist-then-revert flow.

**Why:** The 12-month ideal is a memo that proposes diffs as new material arrives. Today
`INVESTMENT_MEMO_INCORPORATE_CALL` regenerates the targeted sections and immediately persists
a new version (safe to undo via version history, but the user can't preview before it lands).
A diff-preview makes the update feel deliberate and reviewable — the UX half of the living memo.

**Pros:** higher trust in AI edits; no "surprise" version; natural place to show per-section
provenance. **Cons:** a meaningful UI build (diff rendering, per-section accept/reject, a
"staged" memo state); the producer agent would need to return section bodies WITHOUT persisting.

**Context/where to start:** the targeted path already isolates the changed sections —
`spliceTargetedSections` ([packages/services/src/llm/agents/memo-producer-agent.ts](packages/services/src/llm/agents/memo-producer-agent.ts))
produces the merged markdown, and `submittedSections` holds each new section body. A preview
mode would return those (merged + per-section old/new) to the renderer, which renders a diff
and only calls persist on accept. `MemoSectionsNav` already maps sections → headings for the UI.
**Depends on:** the incorporate-new-material feature (shipped). **Priority:** P3.

---

## Mobile — React Query cache persisted UNFILTERED (silent-crash landmine)

**What:** The mobile app persists the *entire* React Query cache to MMKV with no
`dehydrateOptions` filter ([mobile/app/_layout.tsx:47](mobile/app/_layout.tsx#L47)). Any query
whose result *shape* changes under a stable query key across builds will rehydrate the old shape
into the new consumer and can crash on mount — only mitigated by remembering to bump `buster`.

**Why:** First real instance shipped a silent app quit — the Companies tab moved
`useQuery`→`useInfiniteQuery` under `['companies','list',q]`, so a persisted v1 entry rehydrated
as `{companies,total}` and `query.data.pages[0]` threw `undefined[0]`. Fixed in
`fix/mobile-companies-cache-shape-crash` via a tolerant `flattenCompaniesPages` helper + a
per-screen `ErrorBoundary` + `buster: 'v1'→'v2'`. Those are point fixes; the landmine remains for
the next shape change.

**Fix options:** (a) add `dehydrateOptions.shouldDehydrateQuery` to persist only an allowlist of
stable keys; OR (b) derive `buster` from the app build/version number so every release
auto-invalidates the persisted cache. (b) is the smaller, more reliable lever.

**Pros:** removes a whole class of post-release silent crashes; no more "remember to bump buster."
**Cons:** (b) drops the offline cache on every release (one cold refetch per update — negligible at
single-firm scale); (a) needs maintaining the allowlist as queries are added.

**Context/where to start:** `mobile/app/_layout.tsx` `persistOptions` (buster) +
`createAsyncStoragePersister` (dehydrateOptions). The per-screen `ErrorBoundary` added to the
Companies tab is the template for hardening other tab screens (none have one today).
**Depends on:** nothing; independent of the firm-shared work.

---

## Mobile ledger PR2 — Reliable co-investors — Part C: drop the dead column (REMAINING)

**Status:** Parts A+B SHIPPED in PR #42 (`feat/co-investors-reliable`): `company_investors`
is now a synced owned table (lamport col, OWNED_TABLES, validators, firm-scoped pull,
apply spec, device dispatch, `setCompanyInvestors` wrapped in `withSync`), and the
gateway `GET /companies/:id` returns `coInvestors` from the JOIN. **Co-investors appear
on mobile once the desktop app ships migration 128 + the withSync write + a one-time
`scripts/backfill-outbox` pass** (existing rows have lamport '0' and must be enqueued).

**Remaining (Part C):** the legacy `org_companies.co_investors` JSONB is now fully dead
(0/715 in Neon; the join is the source). Drop it. Touchpoints (audited):
- `packages/db/src/schema/companies.ts:90` (remove column) → drizzle generate (PG drop) +
  new SQLite drop migration.
- `src/main/services/sync-remote-apply.ts` — remove `co_investors` from the org_companies
  field-LWW col map (~`['co_investors','coInvestors']`), the upsert INSERT/VALUES/ON-CONFLICT,
  the `PulledOrgCompanyRow` type, and `stringify(row.coInvestors)`.
- `packages/db/src/sqlite/repositories/org-company.repo.ts` — remove the `co_investors`
  row-type field + the `c.co_investors` SELECT projection + the column from the field list (~:2468).
- `packages/db/src/sqlite/repositories/search.repo.ts` — remove `co_investors` from the
  two FTS LIKE clauses (~:951, :1359).
- `api-gateway/src/mcp/tools/get-company.ts` + `mcp/format.ts` — repoint co-investors to the
  `company_investors` JOIN (mirror the gateway detail) instead of `c.coInvestors`; update `mcp-unit.test`.
- `api-gateway/src/shared/sanitize-row.ts` — drop the now-moot `'coInvestors'` denylist entry.
- Tests: `sync-remote-apply-additional-tables.test` ("serialises JSON fields (coInvestors…)"),
  the many `co_investors TEXT` test-table fixtures (harmless extras, trim for parity).
- **Leave** the renderer's `'coInvestors'` field key (companyFields/companyFieldMeta/
  CompanyFieldSections/CompanyPropertiesPanel) — that drives the live join-backed picker (`coInvestorsList`), not the dead column.

Destructive prod migration → sequence the drop LAST (deploy code that stops reading it →
then drop). Conflicts likely with active sync branches; run the migration-drift guard.

**Effort:** M. **Priority:** P3 (column is empty; pure cleanup).

---

## Mobile ledger PR3 — Desktop convergence on the shared field registry

**What:** Make `@cyggie/shared/field-registry` the single source of truth for field
**labels + section + order** across BOTH desktop and mobile, removing the desktop's
hardcoded duplication. Desktop keeps its richer *editor* meta (input types, option
sources, complex pickers) in `companyFieldMeta`/`contactFieldMeta` — distinct concern.

**⚠️ Resolved design (the original "mechanical repoint" framing was WRONG — see scope
findings below).** The mobile registry diverges from desktop and a naive repoint would
*break* desktop. The clean approach is a **platform-aware superset registry** that
changes NEITHER UI:
- Extend `FieldMeta` with optional **`desktopSection`** (lowercase desktop key:
  overview/pipeline/financials/investment/links · contact_info/professional/relationship/
  investor_info), **`desktopLabel`** (when it differs from the mobile label), **`desktopOnly`**
  (no mobile `section`), and **`desktopUi`** (component hint: `companyPicker`/`tagPicker`/etc.).
- Add a `SECTIONS` metadata export: per-platform ordered section list + display labels.
- Add the desktop-only fields to the registry as `desktopOnly` entries: company `status`,
  `hqAddress`, the pipeline section (`sourceType`, `sourceEntityId`, `dealSource`,
  `warmIntroSource`, `referralContactId`, `relationshipOwner`, `nextFollowupDate`), and the
  investor PICKERS (`coInvestors`, `priorInvestors`, `subsequentInvestors` — `desktopUi:'companyPicker'`);
  contact split `typicalCheckSizeMin`/`Max` (desktop shows two fields vs mobile's `checkSize` sentinel).
- Known label diffs to encode as `desktopLabel`: Runway → "Runway (months)", Last met → "Last Met At",
  Prior companies → "Prior Company".

**Mobile change (must be a NO-OP visually):** `mobile/lib/ledger/buildGroups.ts` skips
`desktopOnly` entries and reads the mobile `section` exactly as today. The existing
`buildGroups` fixture tests must still pass unchanged (the card is byte-identical).

**Desktop change (the bulk, ~1,300 lines):** rewrite
`src/renderer/components/{company,contact}/*FieldSections.tsx` to pull each PropertyRow's
**label** + per-section **field membership/order** from the registry (filtered by
`desktopSection`), keeping the existing pickers/editor types via `*FieldMeta`. Then retire
the duplicated label/section data in `src/renderer/constants/{company,contact}Fields.ts`.

**Verification:** mobile builder tests unchanged (card identical) + `tsc`. Desktop has NO
render-test harness — correctness needs **manual QA in the running app**: open a company
and a contact detail and confirm every section, label, order, and the complex pickers
(lead/co/prior/subsequent investors, tag pickers, polymorphic source picker) render and
edit correctly. Header fields (email/phone/linkedin in the hero) must NOT double-render.

**Effort:** L (multi-session; high blast radius on the primary desktop CRM surface;
manual-QA-only). **Priority:** P2. **Depends on / blocked by:** PR1 (registry exists).

---

## Extend the transcription provider picker to the gateway/mobile path

**What:** Make the gateway-side Deepgram batch path honor each user's
`liveTranscriptionProvider` preference, so a user who has picked AssemblyAI
gets AssemblyAI transcripts for mobile recordings too. Today the picker
only affects the desktop live-streaming path; mobile recordings always
produce Deepgram transcripts regardless of setting.

**Why:** Once Cyggie onboards a second firm (current single-firm beta
constraint per `~/.claude/projects/-Users-sandersoncass-Apps-Cyggie/memory/project_provider_key_architecture.md`),
mismatched transcripts between desktop and mobile for the same user become
a real support headache: "the desktop transcript got the prospect name
right but the mobile one didn't." Cross-device consistency is table stakes
for a multi-firm product.

**Context:** Touchpoints:
- `api-gateway/src/routes/recordings.ts` POST `/recordings/upload` — currently always submits to Deepgram batch. Needs to read the user's `liveTranscriptionProvider` (sync target the setting first; or query SQLite-via-Neon-mirror).
- `api-gateway/src/recording/transcribe-job.ts` — add an AssemblyAI batch adapter path next to the existing Deepgram one. Reuse `src/main/transcription-eval/adapters/assemblyai.adapter.ts` as a starting point.
- Per-user key resolution: extend `api-gateway/src/llm/resolve-key.ts` (already supports `deepgram`) to also resolve `assemblyai`. This is the same pattern T24 used for Anthropic; T32 for Deepgram.
- Push notification routing: the existing APNs push (recordings.ts) doesn't need provider-specific changes.
- Reconciliation on gateway restart (`reconcileStuckJobs` in transcribe-job.ts): needs to know which provider's polling endpoint to hit per stuck job. Add provider column to `meetings` on the gateway side too.

**Effort:** L (~3-5 days).

**Priority:** P2.

**Depends on / blocked by:** Desktop picker shipping (done 2026-05-28
on `feat/transcription-eval-cli`) + production validation that AssemblyAI
streaming holds up across multiple real meetings.

---

## Wire the named transcription error codes to Sentry

**What:** Send the structured `error` events emitted by
`DeepgramStreamingClient` and `AssemblyAiStreamingClient` to Sentry instead
of just `console.error`. Named codes:
`MALFORMED_TURN_PAYLOAD`, `UNKNOWN_MESSAGE_TYPE`, `SERVER_TERMINATED`,
`FINALIZE_TIMEOUT`, `MISSING_API_KEY`, `AEC_DIVERGENCE`,
`MULTICHANNEL_REJECTED`, plus the factory's bidirectional
fallback warn-level log.

**Why:** Today these land in the dev console and a packaged-build log file
that nobody reads. In production we want real alerting — "AssemblyAI is
returning malformed Turns to 30% of sessions" is the kind of incident we
should learn about within minutes, not when a user complains.

**Context:** Code locations:
- `src/main/transcription/types.ts` defines `TranscriberErrorCode` — the canonical list.
- `src/main/deepgram/client.ts:21` — `emitError(code, message, context)`.
- `src/main/transcription/assemblyai-streaming-client.ts:108` — same `emitError` helper.
- `src/main/transcription/factory.ts` — emits a `console.warn` when fallback fires; should also push to Sentry.

Implementation:
- Add a Sentry tag `{ provider, code }` on each error event.
- Add a breadcrumb chain so Sentry shows the connect → turn → error sequence.
- Hook from the renderer's `RECORDING_ERROR` channel handler so user-visible errors also push to Sentry from the UI side (already structured by the time it arrives).

**Effort:** S (~2 hrs).

**Priority:** P2.

**Depends on / blocked by:** Cyggie having a Sentry project configured for
the desktop (gateway already has one per
`~/.claude/projects/-Users-sandersoncass-Apps-Cyggie/memory/project_provider_key_architecture.md`).

---

## Transcription eval — actually invoke the proper-noun corrector

**What:** `scripts/transcription-eval/run-eval.ts` and
`src/main/transcription-eval/service/transcribe-eval.service.ts` declare a
`crmNames?: string[]` parameter on `RunArgs` (transcribe-eval.service.ts:40)
but never invoke `correctTranscriptMarkdown` on the output. WER /
side-by-side comparisons currently reflect the RAW provider output, not the
post-corrected transcript that ships to the user.

**Why:** Misleading apples-vs-oranges: the live pipeline benefits from CRM
proper-noun correction; the eval doesn't, so we judge providers without the
benefit Deepgram gets in prod. The comment at
`packages/services/src/recording/normalize-segments.ts:1-11` is aspirational
— it claims both pipelines apply the same correction, but only the live
path actually does.

**Context:** Two callsites need wiring:
(1) The eval service should accept `crmNames` and call
`correctTranscriptMarkdown` on each provider's markdown before writing
segments / text to disk.
(2) `scripts/transcription-eval/run-eval.ts` should source `crmNames` the
same way `RecordingSession` does post-2026-05-28
(`contacts + companies + meeting.selfName + meeting.attendees`, not just
`contacts + companies` — see the Sandy→Andy fix in
`~/.claude/plans/snazzy-seeking-crystal.md`).

**Depends on / blocked by:** The Sandy→Andy fix landed 2026-05-28
(canonical-token guard in proper-noun-corrector.ts + meeting-record source
in RecordingSession.ts). Wiring the eval now will reflect the corrected
behavior.

---

## Transcription provider eval — fallback to WER if side-by-side is inconclusive

**What:** Extend `scripts/transcription-eval/run-eval.ts` to accept a
`--reference-dir=<path>` flag and compute Word Error Rate (Levenshtein on
tokenized streams, lowercase + punctuation stripped) against
hand-corrected reference transcripts. Output as an extra column in the
markdown summary table.

**Why:** The current eval ships side-by-side text diffs only (per the
2026-05-27 eng-review decision: skip WER for v1 to ship faster). If 5
minutes of staring at side-by-side transcripts doesn't make a winner
obvious, fall back to an objective metric.

**Context:** Requires hand-correcting 3–5 representative meetings
(30–90 min each) into `eval-fixtures/reference/<id>.txt`. The CLI then
loads them, computes WER against each provider's `transcript_text`, and
adds a `wer` column. Plan: `~/.claude/plans/can-you-scope-out-wise-locket.md`.

**Depends on / blocked by:** Initial side-by-side eval producing
inconclusive results. Audio must be saved (already shipped — the AAC
encoder writes `<recordingsDir>/<id>.m4a` on every recording).

---

## Per-word confidence-gated CRM rewriting

**What:** Replace the threshold-based proper-noun corrector at
`src/main/utils/proper-noun-corrector.ts` with a confidence-gated approach:
only rewrite a word to a CRM canonical name if the underlying Deepgram
per-word confidence is below some threshold (e.g. 0.8). If the model is
confident the word is what it transcribed, trust the model — don't
fuzzy-promote it to a similar CRM name.

**Why:** Threshold tuning (0.92 → 0.97 per the 2026-05-29 fix) is a moving
target. As CRM grows, more contact/company names will phonetically collide
with common English words ("more"/"Smore", "bunch"/"Buncha"). A confidence
gate is structurally better: it scopes correction to where the model
itself was uncertain. The current threshold-tuning approach will eventually
either over-correct (false positives) or under-correct (misses real
misspellings) — we can't optimize both at once with a single number.

**Context:**
- Correction currently runs on assembled markdown
  (`correctTranscriptMarkdown` at `packages/services/src/recording/normalize-segments.ts:68`),
  which has thrown away per-word confidence. To plumb confidence through,
  correction needs to move earlier — either onto `TranscriptSegment[]`
  where word-level `confidence` is still attached, or as a parallel pass
  that reads segments and rewrites the markdown using segment-level word
  metadata.
- AssemblyAI Universal-Streaming does NOT emit per-word confidence. For
  AssemblyAI sessions, fall back to threshold-based correction (current
  behavior at the 0.97 threshold) or skip correction entirely; document
  the choice.
- Deepgram per-word confidence is already in the normalized word schema
  (`src/main/deepgram/types.ts:38` — `NormalizedWord.confidence`), so the
  plumbing is short.

**Effort:** M (~2 days).

**Priority:** P2.

**Depends on / blocked by:** 2026-05-29 threshold fix (0.92 → 0.97)
shipping first to confirm whether threshold-only tuning is enough. If
Sandy still hits false-positive rewrites at 0.97, escalate to this.

---

## WebRTC AEC3 native module for stereo capture

**What:** Replace the in-worklet NLMS adaptive filter shipped with the
"separate transcription for you and others" feature (2026-05-29) with
WebRTC's AEC3 algorithm via a native Node module. AEC3 is what Chrome and
Meet use; it delivers ~30 dB suppression vs NLMS's ~10–20 dB.

**Why:** Conditional on the 2026-05-29 NLMS shipping and leaving audible
residual bleed. NLMS is good enough as a starting bet (no native deps, runs
in worklet, handles the easy case), but spectral nulls, codec artifacts,
and rapid speech onsets will leave residue that AEC3 catches.

**Context:**
- Plan: `~/.claude/plans/we-need-to-improve-cheeky-treasure.md` documents
  the NLMS-first decision and notes WebRTC AEC3 as the escalation path.
- Candidate npm packages: `webrtc-audio-processing` (pulls in WebRTC's
  `apm`), `node-aec` (alpha quality — vet carefully). May need to compile
  a WASM build of WebRTC's `AEC3` directly to avoid native-rebuild pain.
- Integration point: same place NLMS sits today —
  `src/renderer/hooks/useAudioCapture.ts` AudioWorklet. Native module
  needs to be callable from the worklet thread, which is tricky (no Node
  bindings in worklets); may need to move AEC to the main process post-IPC.
- Electron rebuild: native modules require `electron-rebuild` per
  platform; adds to packaging complexity.

**Effort:** L (~3-5 days: vet module, integrate with Electron, possibly
move AEC out of worklet into main process, validate vs NLMS baseline).

**Priority:** P3.

**Depends on / blocked by:** Multichannel + NLMS shipping first. Eval
metrics showing NLMS residual bleed > acceptable threshold on Sandy's
real meetings.

---

## AssemblyAI stereo / per-channel transcription parity

**What:** Provide a per-channel (mic + system separate) transcription
mode on AssemblyAI to match the Deepgram multichannel path shipped
2026-05-29. Today the "separate transcription for you and others" toggle
is disabled when `provider === 'assemblyai'`.

**Why:** Provider parity. Users on AssemblyAI today get worse speaker
attribution than Deepgram users because they can't enable the toggle. As
AssemblyAI usage grows, this becomes a feature gap.

**Context:**
- AssemblyAI Universal-Streaming v3 does not have a `multichannel` flag
  the way Deepgram does. Two implementation paths:
  1. **Two parallel websockets** — one per channel. Doubles AssemblyAI
     spend per session. Most direct path. Needs timeline merge/dedup
     similar to the Deepgram cross-channel dedup at
     `src/main/deepgram/transcript-assembler.ts`.
  2. **Wait for AssemblyAI to ship multichannel** — unknown ETA; check
     their roadmap.
- `resolveStreamConfig` helper (shipping 2026-05-29) is the integration
  point — extend it to return per-provider config that includes either
  `channels: 1` (current behavior) or `parallelStreams: true` (new
  AssemblyAI path).
- Once shipped, remove the AssemblyAI-disabled guard on the settings
  toggle.

**Effort:** M-L (~3-5 days for two-websocket path, including timeline
merge).

**Priority:** P3.

**Depends on / blocked by:** Deepgram multichannel + dedup + NLMS shipping
and proving the pattern works in real meetings. AssemblyAI usage volume
high enough to justify the work (single-firm beta currently has Deepgram
as default).

---

## Keyboard shortcut to cycle reading density

**What:** A keyboard shortcut (e.g. `Cmd+Shift+=` / `Cmd+Shift+-`) that steps
the reading line-spacing preference through compact → normal → relaxed without
opening Settings.

**Why:** Power users adjust reading comfort mid-session; a shortcut makes it
feel native and discoverable — "oh nice, they thought of that." The Appearance
tab (shipped with the reading-appearance feature) is the canonical home, but a
shortcut removes the friction of navigating there each time.

**Context:** Lands cleanly once `src/renderer/lib/appearance.ts` and
`src/renderer/hooks/useAppearance.ts` exist (shipped with the reading-appearance
feature). Bind in the renderer keymap and call the same
`setJSON('cyggie:appearance', next)` the Settings tab and the TiptapBubbleMenu
"Aa Display" popover use — `lib/appearance.ts` is the single source of truth, so
all three stay in sync. Consider cycling `fontSize` on a second chord.

**Effort:** S.

**Priority:** P3.

**Depends on / blocked by:** Reading-appearance feature
(`lib/appearance.ts` + `useAppearance`) shipping first.

---

## "Reset to defaults" in the Appearance settings tab

**What:** A reset link/button in `AppearanceSection` that restores line spacing,
font size, and line width to the shipped defaults in one click.

**Why:** Users experiment with density settings and want an obvious way back to
the known-good baseline; avoids "how do I undo this / what was the default again"
confusion and support pings.

**Context:** Trivial once `src/renderer/lib/appearance.ts` exposes a `DEFAULTS`
constant (it does, as of the reading-appearance feature) — the handler is
`setJSON('cyggie:appearance', DEFAULTS)`. Place next to the three segmented
controls in `src/renderer/components/settings/AppearanceSection.tsx`.

**Effort:** S.

**Priority:** P3.

**Depends on / blocked by:** Reading-appearance feature shipping first.

---

## Persist reading density per-window

**What:** Let each app window remember its own reading density instead of a
single global value applied to `document.documentElement`.

**Why:** A user with a wide main window and a narrow side/detached window may
want different line lengths (measure) per window — a wide window can afford a
roomier `--cy-reading-mw` than a cramped one.

**Context:** ⚠️ Design tension — this conflicts with the global-preference model
the reading-appearance feature is built on (one `cyggie:appearance` value applied
once at the root). Building it requires a decision on global-vs-per-window source
of truth, then keying appearance by window id and applying per `BrowserWindow`
rather than at a single `documentElement`. Revisit **only** if the global model
proves too coarse in real use — do not build speculatively.

**Effort:** M.

**Priority:** P3.

**Depends on / blocked by:** Reading-appearance feature shipping first **and** a
global-vs-per-window design decision.

---

## P1 — Mobile V1 (Phase 0–M7)

Tracker for the Cyggie Mobile V1 + cloud rearchitecture initiative.
Plan: `/Users/sandersoncass/.claude/plans/claude-code-prompt-jolly-eagle.md`.
Project memory: `~/.claude/projects/-Users-sandersoncass-Apps-Cyggie/memory/project_mobile_v1.md`.

### Mobile Chat — three-phase rollout

Plans: `~/.claude/plans/chat-on-mobile-needs-humble-crown.md` (Phase 1) + `~/.claude/plans/mobile-chat-phase-2-global-companies-picker.md` (Phase 2).

| # | Phase | Status | Notes |
|---|---|---|---|
| MC.1 | Mobile "New Chat" affordance (pencil icon on Ask Cyggie tab + kebab row on per-entity screens) + clear-on-session-swap + abort-in-flight | ✅ shipped | commits 866bf1d + 2c4e695. useStartNewChat hook + useClearOnSessionSwap hook + ChatComposer imperative `abortInflight` handle; 11 new tests across both hooks |
| MC.2 | Global Ask Cyggie: selectable company context | ✅ shipped | commit f048214. `selected_company_ids jsonb` column on `chat_sessions` (Postgres + SQLite mig 102); pill row + multi-select sheet; batched `buildSelectedCompaniesContext` helper (3 queries regardless of selection size — companies + meetings + flagged-file text); 8 new gateway tests. RN component tests deferred per repo policy (see MC.runner below) |
| MC.3 | Company chat: gateway-side parsed_text for flagged files | ✅ shipped | Desktop extraction worker fills `extracted_text` on flag; `company_flagged_files` wrapped in `withSync` via four verbs (`flagFile` / `unflagFile` / `refreshFlaggedFile` / `updateFlaggedFileExtraction`) at [packages/db/src/sqlite/repositories/index.ts:579-626](packages/db/src/sqlite/repositories/index.ts#L579-L626); gateway `buildSelectedCompaniesContext` Query 3 pulls extracted_text with `status='done'` filter, 8K per-file cap, 300K total cap ([api-gateway/src/routes/chat.ts:1386-1461](api-gateway/src/routes/chat.ts#L1386-L1461)); 7-case test suite at [api-gateway/test/chat-flagged-files.test.ts](api-gateway/test/chat-flagged-files.test.ts). Desktop pull-side primitive (multi-device) deferred — see T-MC.3-pull in P2 — Sync section |

### Chat sessions — schema split for contextId (post-Mobile-V1)

**What:** Replace the `chat_sessions.contextId = "<kind>:<entity-id>"`
string convention with a real schema split: keep `context_kind` (already
exists) and add a new `entity_id` column, then move the
`chat_sessions_active_idx` unique index from `contextId` alone to
`(context_kind, entity_id) WHERE is_active=1`. Drop the
`stripContextIdPrefix` helper and the mobile-side template-literal
encode sites once the migration is complete.

**Why:** The current `<kind>:<id>` string is a workaround for the
unique index living on `contextId` alone. The May 2026 "company-detail
chat has empty context" bug existed because the encoding rule was
implicit and the gateway dispatcher silently dropped the prefix
mismatch. A schema split would make typos structurally impossible —
the entity column would be a bare UUID with no string parsing. Also
fixes the desktop-vs-mobile encoding asymmetry: today
[src/shared/utils/chat-context.ts:30](src/shared/utils/chat-context.ts#L30)
writes bare meetingId for kind=meeting on desktop while mobile prefixes
all three kinds, which means cross-device session syncing has to
defensively strip in both shapes.

**Pros:** Eliminates an entire bug class; deletes the
`@cyggie/shared/chat-context-id` helper, the mobile encode sites, and
the gateway/renderer decode sites; lets the database enforce what's
currently a string convention spread across three packages.

**Cons:** Postgres migration with backfill (split every existing
`contextId` by `:`); coordinated changes in mobile (3 entry points),
desktop renderer ([ChatPanelRoot.tsx](src/renderer/components/chat-panel/ChatPanelRoot.tsx)),
gateway (every read of `contextId`), schema, sync layer
([owned-tables.ts](packages/db/src/sync/owned-tables.ts)), and the chat
test suites. Probably 8–12 files. Cannot ship without all clients
shipping simultaneously (mobile App Store rollout window applies).

**Context:** The prefix convention dates to commit `e34a390` ("Slice
1"). Decode sites today: `stripContextIdPrefix` in
[packages/shared/src/chat-context-id.ts](packages/shared/src/chat-context-id.ts)
(added in the May 2026 bugfix PR) and its two call-sites in the gateway
dispatcher + desktop renderer. Encode sites: mobile
[companies/[id].tsx](mobile/app/companies/[id].tsx),
[contacts/[id].tsx](mobile/app/contacts/[id].tsx),
[meetings/[id].tsx](mobile/app/meetings/[id].tsx) (template literal).
The bugfix PR also added a `'per-entity session resolved to null
context block'` warning that covers the immediate observability gap,
so this work is no longer urgent — purely structural cleanup.

**Depends on:** Nothing — entirely independent. Defer until the mobile
App Store release cadence allows coordinated client + server rollout.

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

### Surface Anthropic `usage` from `ClaudeProvider.generateSummary`

**What:** Widen the desktop `LLMProvider.generateSummary` return type
from bare text to `{ text: string; usage: Anthropic.Messages.Usage }` so
call sites (company / contact key-takeaways, meeting summarizer, the two
summary-sync field-extractors) can record `cache_read_input_tokens` /
`cache_creation_input_tokens` the same way `agent_runs.*` columns do
today for agent-loop runs.

**Why:** Without this, any future decision to enable prompt caching on
those one-shot paths is blind — we can't measure whether the regen-rate
clears the 1.28-turn break-even, and silent invalidators in shared
system prompts go unnoticed. The internal AI chat path
([api-gateway/src/routes/chat.ts](api-gateway/src/routes/chat.ts))
already logs `chat.sessions.usage` post-stream after the
`cacheEnabled`-toggle work landed; this TODO mirrors that pattern to the
desktop summarizer surface.

**Pros:** Unlocks a data-driven decision on whether to add caching to
key-takeaways / summary-sync; reuses the same `metric=chat.sessions.usage`
shape so a future cost dashboard works uniformly across surfaces.

**Cons:** Touches every `generateSummary` call site (~5 files). Requires
either a separate per-route audit log or a new lightweight
`llm_call_usage` table (desktop). The boolean return-shape change is
backwards-incompatible across the interface.

**Context:** Plan
`~/.claude/plans/make-sure-we-re-using-inherited-mango.md` deferred this
deliberately while shipping the per-chat caching toggle. Today the
provider returns bare text; widening to `{text, usage}` is the
prerequisite for any future LLM-cost dashboard that covers desktop
flows. See [packages/services/src/llm/claude-provider.ts](packages/services/src/llm/claude-provider.ts)
+ call sites in [company-key-takeaways.ts](packages/services/src/llm/company-key-takeaways.ts),
[contact-key-takeaways.ts](packages/services/src/llm/contact-key-takeaways.ts),
[summarizer.ts](packages/services/src/llm/summarizer.ts),
[company-summary-sync.service.ts](packages/services/src/company-summary-sync.service.ts),
[contact-summary-sync.service.ts](packages/services/src/contact-summary-sync.service.ts).

**Effort:** M (~4 hours: interface change + 5 call-site touches +
audit-log / log-line plumbing + tests).

**Priority:** P2 — enables a future caching decision, not blocking
current work.

**Depends on:** Nothing.

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

### PipelineStepper — visual-regression / layout-collision coverage

**What:** Add a Playwright (or other visual-regression) check that confirms
the 7-dot PipelineStepper renders without label collisions or off-edge
clipping across the right-rail's expected width range (e.g., 280px, 320px,
400px, 480px). The Vitest RTL suite at
[src/renderer/components/common/__tests__/PipelineStepper.test.tsx](src/renderer/components/common/__tests__/PipelineStepper.test.tsx)
covers state semantics + click behavior but NOT layout — angled labels at
−30° lean away cleanly at normal widths, but a future stage-label rename or
a panel-width regression could silently break the visual.

**Why:** Three silent-failure modes were flagged in the 2026-05-25 eng review
of the 7-dot upgrade (label collision, first-label off the left edge, dot
overlap at narrow widths). None are catchable by RTL because jsdom doesn't
do real layout. The current mitigation is manual QA at multiple panel
widths during verification.

**Context:** Came out of the 7-dot PipelineStepper PR (commits TBD). Plan
file: `~/.claude/plans/can-you-fix-the-groovy-candy.md`. The component
itself lives at
[src/renderer/components/common/PipelineStepper.tsx](src/renderer/components/common/PipelineStepper.tsx)
with sibling CSS module.

**Depends on:** Playwright (or chosen tool) being added to the test
toolchain. There's no existing visual-regression infra in this repo, so
this is "build the tooling, then add the check" — not a 1-line follow-up.

---

### M5-thin follow-ups (deferred from the pre-build M5-thin slice)

The M5-thin slice (commit TBD on `main`, 2026-05-22) shipped a working
Chat tab + Notes Enhance button against new gateway routes `POST /chat/messages`
and `POST /chat/enhance-notes`. Both are stateless one-shots — no
persistence, no streaming, no citations, no Tiptap rewrite. These items
fill out full M5 in subsequent passes.

| # | What | Why | Effort | Notes |
|---|---|---|---|---|
| **T17** ✅ SHIPPED | **Chat session persistence + Neon sync** | Mobile Chat tab forgets every conversation on tab unmount. Desktop has `chat_sessions` + `chat_session_messages` tables (migrations 078-080) but they're SQLite-local — never written to Neon. To make mobile chat persist AND sync to desktop, mirror those tables in Neon, add `GET /chat/sessions`, `POST /chat/sessions`, `GET /chat/sessions/:id/messages`, then route desktop writes through the Phase 1.5a outbox the same way `meetings` flow does. **PRIORITY:** promoted from P2 → **P1** on 2026-05-23 (plan-ceo-review REDUCTION pass) — multiplayer-by-default in V1 means chat history must survive across teammates and devices. | L (~3-5 days) | Reuses `withSync` wrapper + applyRemote primitive from Phase 1.5a/c. T14 covers the multi-table pull side. |
| **T18** ✅ SHIPPED | **SSE streaming for /chat/messages** | Today the route awaits the full Claude response (often 8-15s for long replies) before returning anything. UX would be much better with token-by-token streaming. Anthropic SDK supports `client.messages.stream()`; Fastify handles SSE via `reply.raw.write()`. | M (~2 days) | Mobile-side: `EventSource`-style consumer via `expo-fetch` or a polyfill (RN doesn't have `EventSource` natively). Test against a mocked SSE producer to keep Claude out of CI. |
| **T19** ✅ SHIPPED | **Multi-turn chat (history sent with each message)** | The current route is one-shot — every message is a fresh conversation. Users will expect "as we just discussed…" follow-ups. Cheapest path: client sends `messages: [{role,content}…]` array, gateway forwards as-is to Anthropic. Needs context-budget management (truncate oldest user turns when total exceeds ~50KB). | S (~half day) | Depends on T17 only if we want history to survive app kill. Without T17, history lives in `useState`. |
| **T20** | **Citations into transcript ranges** | When the chat reply references a meeting, link `[1]` `[2]` style citations back to specific transcript segments. Tap a citation in mobile → scrolls to that point in the meeting detail's transcript view. | L (~3 days) | Requires the chat prompt to ask for structured `<cite seg="…">` blocks + a parse step on the gateway. Mobile UI changes are small once the data shape lands. |
| **T21** | **Tiptap notes editor (replace plain TextInput on meeting detail)** | Plain TextInput works but is single-style and clunky for multi-paragraph notes. Tiptap (via `@tiptap/react-native` or equivalent) gets us bullets, headings, links. Desktop already uses Tiptap — porting brings parity. | L (~4-5 days) | Notes Enhance still works through Tiptap (replace the editor content via the doc API). |
| **T22** | **"Diff modal" for Enhance** | Today's Enhance is silent-replace (with a confirm dialog). Better UX: show before/after side-by-side, let user accept/reject hunks. | M (~2 days) | Use existing `diff` package (already a mobile dep). Mobile diff UI patterns from MeetingDetail conflict modal. |
| **T23** ✅ SHIPPED | **Test coverage for new chat routes** | `POST /chat/messages` and `POST /chat/enhance-notes` ship without tests because external-API routes were skipped (Anthropic SDK call). Cleanest path: a tiny `FakeAnthropic` mock in `api-gateway/test/_helpers/` + 4-5 happy/error cases per route. | M (~1 day) | Matches the fake-Deepgram pattern already in TODOS (Phase 0.6 follow-up). |
| **T24** | **BYO-key — per-user Anthropic key on the gateway** | M5-thin shipped with the gateway reading `env.ANTHROPIC_API_KEY` directly on every chat request. That works for a single-firm beta (one firm = the developer's key) but is wrong the moment external users land — they would all unknowingly bill against the gateway-owner's Anthropic account, eat into one shared rate limit, and have no way to set their own key. The existing memory note about Deepgram keys ("Desktop app stores a per-user key in SQLite; gateway needs a separate gateway-owned key in env. Don't conflate.") covers a *different* axis (per-user vs gateway-owned for ingestion) and does not solve this. The Anthropic key needs a *third* tier: per-user-overridable. **Sketch:** add `user_settings.anthropic_api_key` column (encrypted at rest via pgcrypto or app-level encryption); gateway resolves the key in priority order `user_settings.anthropic_api_key → env.ANTHROPIC_API_KEY → 503`. Desktop Settings already has a "Claude API Key" input (`getCredential('claudeApiKey')`) — extend the existing settings sync path (Phase 1.5a outbox already handles `user_settings.*`) so a desktop paste propagates to Neon, which the gateway then reads on each chat request. Mobile gets a matching field in the Settings screen shipped in da5f34a. **Until T24 ships, the gateway is single-tenant for AI features** — do not onboard a second firm before this lands. **STATUS:** ✅ shipped via commits 6e2c63a + 742bb69. user_credentials table holds per-user key; gateway resolves via resolveAnthropicKey helper; desktop pushes via pushAnthropicKey on Settings save + on startup. | L (~2-3 days) | Depends on Phase 1.5a user_settings sync path (already wired for other settings). Same encryption pattern likely applies to OpenAI / Ollama keys when those providers come back online server-side. |
| **T32** | **BYO-key — Deepgram (extend `user_credentials`; delete gateway env var)** | Mirror T24 for Deepgram. Today: desktop uses per-user key from SQLite for live-stream; gateway uses its own `DEEPGRAM_API_KEY` env var for mobile-uploaded batch transcription — same multi-firm trap T24 was solving for Anthropic. **Sequencing (decided 2026-05-23, plan-ceo-review Issue 1A):** (1) extend `user_credentials` provider enum to `'deepgram'`, (2) extend `resolveProviderKey` to handle deepgram, (3) extend desktop push path so the existing `deepgramApiKey` in SQLite settings propagates to `user_credentials` on Settings save + on startup, (4) extend mobile Settings UI with a Deepgram key field that calls the same endpoint, (5) verify Sandy's Deepgram row exists in Neon, then (6) **delete `DEEPGRAM_API_KEY` from Fly secrets** (`flyctl secrets unset DEEPGRAM_API_KEY`) — hard cutover, no fallback. Adds a Sentry alert for "Deepgram 401 from gateway" so a missing key row surfaces immediately. **Gates safe multi-firm onboarding.** **STATUS:** ✅ shipped — PR-A (resolver + desktop push paths, env fallback retained) in commit afc4d1d; PR-B (drop env fallback, env.ts optional, Sentry 401 alert) in commit ff4ed74. Sandy's `(provider='deepgram', length=40)` row verified in Neon 2026-05-23 13:14:02 UTC. Final manual step **confirmed clean 2026-05-25**: `DEEPGRAM_API_KEY` is not present in `flyctl secrets list -a cyggie-gateway` (only `DEEPGRAM_WEBHOOK_SECRET` remains, which is the inbound-webhook signature key — separate concern). Gateway is fully on per-user `user_credentials` resolution; no shared env-key fallback exists. Mobile Settings UI for Deepgram deferred — desktop push is sufficient for V1 (Sandy is on desktop). | M (~1 week) | **P1.** Reuse T24's resolveProviderKey pattern verbatim. Deepgram billing collapses to one per-user account (the user pays for both desktop live-stream and gateway batch). Acceptable at single-firm beta scale; revisit if multi-firm onboarding ever wants Cyggie-pays-for-trial transcription. |
| **T33** ✅ SHIPPED | **BYO-key — remaining providers (OpenAI, Exa, WebShare)** | Same pattern as T24/T32 for the three remaining gateway-relevant providers. **Memo deliberately excluded** (decided 2026-05-23) — memo-writing stays desktop-only for the foreseeable future, so the gateway never calls a memo API. None of these are wired to gateway routes today (so unlike Deepgram, no env-var-deletion sequencing risk), but they need to be plumbed for parity before any non-Anthropic gateway route ships (specifically T3 enrichment relocation, which is the only consumer that benefits). Mechanical: extend `ALLOWED_PROVIDERS` enum + DB CHECK constraint + `resolveProviderKeyFromDb` union + `PushableProvider` union + 3 SETTINGS_SET hooks. Bundle as one PR. | S (~3 hours total) | P3. Becomes P1 the moment T3 (or another gateway route for OpenAI/Exa/WebShare) is scheduled. |
| **T34** | ~~Markdown styles to a shared mobile file~~ | **SHIPPED.** `mobile/lib/markdown.tsx` exports `<RichMarkdown>`, `richMarkdownStyles`, `chatMarkdownStyles`, `stripMarkdown`, plus a `handleLinkPress` that wires `Linking.openURL` with a warn-on-failure catch. All six consumers (notes detail, memo detail, meeting summary, chat, contact notes/key-takeaways, company description) now go through it; previously-duplicated style blocks deleted. Also enables `markdown-it` `linkify` (naked URLs become tappable) and fixes the long-standing bug where `[text](url)` links rendered as styled but non-tappable text. Tests in `mobile/lib/__tests__/markdown.test.ts`. | — | — |
| **T35** | **Horizontally scrollable SegmentControl** | Company detail now has 5 tabs (Overview / Meetings / Memos / Notes / People). On iPhone SE (320pt) this is at the edge of what fits without truncation. Today's `SegmentControl` in `mobile/app/companies/[id].tsx` (~line 205) is a flat `<View>` with equal-width children; no horizontal overflow handling. **Fix:** wrap in `<ScrollView horizontal>` with `showsHorizontalScrollIndicator={false}` and `contentContainerStyle` for centered alignment when width permits. Apply same fix to meeting detail's segment control (4 tabs today; could grow). | M (~half day) | P3. Trigger: a user reports cramped UI on iPhone SE OR detail screens routinely add a 6th tab. |
| **T36** | **Memo version history viewer on mobile** | Today mobile shows only the latest version's contentMarkdown. Desktop's memo editor lets users view/restore prior versions via `investment_memo_versions` table. Mobile equivalent: add a version-switcher pill in the memo-detail topbar that opens a list of versions ordered by `versionNumber DESC` with `change_note` previews. Tap a version → re-fetch `GET /memos/:id?version=N` (new query param on the existing route) → swap the markdown body. | M (~1 day) | P3. Defer until a user asks; the typical mobile workflow is "skim the latest" not "compare versions". |
| **T37** | **Memo evidence drill-in on mobile** | `memo_evidence` table (migrations 085 + 090) links each memo claim to source meetings / transcripts / web URLs. On desktop, clicking a claim jumps to the source. Mobile equivalent: when rendering memo markdown, inject inline tappable links for claims that have evidence rows; tap → push to `/meetings/:id` with a scroll target at the right transcript range (or web URL via Linking.openURL). Significantly enhances the read view's value as a "verify a claim while skimming on the go" tool. Requires extending `GET /memos/:id` response to include evidence joins, OR a separate `GET /memos/:id/evidence` endpoint. Inline-link injection on the mobile side requires parsing the markdown to identify claim sentences — non-trivial. | M-L (~2-3 days) | P3. Trigger: user signal that they want this on mobile (it might stay primarily a desktop drafting workflow). |
| **T38** ✅ SHIPPED | **SyncAgent adaptive batching + outbox payload trimming** | T17a A1 verification surfaced a real issue 2026-05-23: gateway returned `FST_ERR_CTP_BODY_TOO_LARGE` (413) on `/sync/push` when desktop's 200-row batch included meeting rows with large `transcript_segments` JSONB plus newly-added chat_session_messages. Bandaid landed in commit TBD: bumped gateway `bodyLimit` 10 MB → 50 MB. Real fix has two parts. **(a) Adaptive batching in `src/main/services/sync-agent.ts`:** on 413, halve the batch size and retry; persist the discovered safe-batch ceiling in `sync_state` so subsequent ticks start at the right size. **(b) Outbox payload trimming in `_sync.ts` / `withSync()`:** for UPDATE ops, emit only the columns that actually changed (or at minimum exclude large-JSONB columns the caller didn't touch). Today every outbox UPDATE emits the entire row including unmodified large fields. Both fixes together let the gateway keep a sane body limit and stop the cascade where one big meeting blocks the whole queue. | M (~2-3 days for both) | **P2.** 50 MB bandaid is fine for single-firm beta; revisit before multi-firm onboarding — a hot meeting with many transcript updates could still overflow under concurrent edits. |
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

### T1 — `/sync/pull` pagination ✅ SHIPPED
**Reconciled 2026-06-21:** SHIPPED — `pullPageSize()` + per-table `PULL_PAGE_SIZE` limit + `hasMore` cursor in `api-gateway/src/routes/sync.ts`; dedicated `api-gateway/test/sync-pull-pagination.test.ts`.
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

### T3 — Port enrichment to `@cyggie/services` so gateway can fire it ⏳ OPEN (now unblocked)
**Reconciled 2026-06-21:** still OPEN — `@cyggie/services` only has `stub-enrichment.service.ts`; the real `syncContactsFromAttendees` + company enrichment remain desktop-only, and the gateway path still SKIPS them (`api-gateway/src/routes/meetings.ts` per plan-ceo 4A). **But its only stated blocker — Phase 1.5c (T4) — has now shipped**, so T3 is unblocked and is the cleanest remaining P1 piece of real work.
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

### T4 — Phase 1.5c: desktop pulls from Neon ✅ SHIPPED
**Reconciled 2026-06-21:** SHIPPED — `src/main/services/sync-pull.service.ts` (polling pull loop) + `applyRemote*` primitives in `src/main/services/sync-remote-apply.ts`. Note: this **unblocks T3** (its only stated dependency was Phase 1.5c).
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

### T5 — Record button on meeting detail screen ✅ SHIPPED
**Reconciled 2026-06-21:** SHIPPED — `RecordCTA` / `MeetingActionsRow` in `mobile/app/meetings/[id].tsx` ("Start recording" on scheduled meetings).
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

### T8 — Lamport-forgery protection (forge-able locks) ✅ shipped
**STATUS:** ✅ shipped. Gateway-side ceiling check lives at
[api-gateway/src/sync/validate-lamport.ts](api-gateway/src/sync/validate-lamport.ts)
with `MAX_LAMPORT_SKEW_MS = 5 * 60 * 1000` (5-minute skew window).
Both clients seed lamport from `Date.now()` (desktop
[packages/db/src/sync/sync-clock.ts](packages/db/src/sync/sync-clock.ts)
+ mobile [mobile/lib/sync/clock.ts](mobile/lib/sync/clock.ts)), so any
incoming lamport > `Date.now() + 5min` is rejected as forged. Wired
into `/sync/push` at
[api-gateway/src/routes/sync.ts:125](api-gateway/src/routes/sync.ts#L125)
and `PATCH /meetings/:id` at
[api-gateway/src/routes/meetings.ts:625](api-gateway/src/routes/meetings.ts#L625);
both reject 400 with stable error codes on `unparseable` /
`too_far_future`. **Original scope below preserved for archaeology.**

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

### T9 — Mobile calendar tab: show multi-day events (today + next 14) ✅ shipped
**STATUS:** ✅ shipped. `groupByDay()` + `formatDayLabel()` live at
[mobile/lib/api/calendar.ts:181-200](mobile/lib/api/calendar.ts#L181-L200);
multi-section list renders via `CalendarDaySection` interface at
[mobile/app/(tabs)/calendar.tsx:29-30](mobile/app/(tabs)/calendar.tsx#L29-L30).
Mirrors desktop's `groupCalendarEventsByDate` pattern.

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

### T10 — Gateway Zod: accept ISO datetime with timezone offset ✅ shipped
**STATUS:** ✅ shipped. `startTime` + optional `endTime` both accept
offset form at
[api-gateway/src/routes/meetings.ts:443-445](api-gateway/src/routes/meetings.ts#L443-L445)
via `z.string().datetime({ offset: true })`. Comment at line 440 ties
back to T10.

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

### T11 — Meeting detail: hide empty stats for `scheduled` rows ✅ shipped
**STATUS:** ✅ shipped. `StatsCard` in
[mobile/app/meetings/[id].tsx:399-441](mobile/app/meetings/[id].tsx#L399-L441)
branches on `hasTranscript`: pre-transcript renders Status always +
Duration only when a scheduled slot is known
(`slotMin = (scheduledEndAt - date) / 60_000`, gated by
`slotMin !== null`); post-transcript renders the full Duration / Status
/ Speakers triplet with Speakers gated by `meeting.speakerCount > 0`.

**What:** StatsCard renders Duration / Status / Speakers always.
For `status='scheduled'` rows (no recording yet), Duration is `—` and
Speakers is `—`. Two of three cells are empty placeholders.
**Fix:** when meeting.status === 'scheduled', omit Duration + Speakers
cells. Or replace Duration with the calendar slot length once T12
(below) lands.
**Why:** UX polish — surfaced by the cathedral-build E2E review.

### T12 — Persist scheduled end time on meetings table ✅ shipped
**STATUS:** ✅ shipped. Postgres migration `0015_meetings_scheduled_end_at.sql`
added the column; SQLite parity migrated. Schema field at
[packages/db/src/schema/meetings.ts:64](packages/db/src/schema/meetings.ts#L64)
(`scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true })`,
nullable). Endpoint accepts optional `endTime` at
[api-gateway/src/routes/meetings.ts:445](api-gateway/src/routes/meetings.ts#L445).
Powers the "60 min scheduled" pre-transcript Duration cell in T11.

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

### T14 — Phase 1.5c expansion: pull more tables alongside meetings ✅ shipped
**STATUS:** ✅ shipped (commit `6a8e702`, 2026-05-24). All eight
mobile-mutable owned tables now flow through the desktop pull path:
meetings + notes + org_companies + org_company_aliases + contacts +
contact_emails (T14 original scope) plus chat_sessions +
chat_session_messages (added in the same commit as Bug B of the sync-
staleness fix). Same commit also wired renderer subscriptions to all
six existing `*_REMOTE_APPLIED` IPC broadcasts (Bug A) via a new
`useRemoteApply` hook + `INVALIDATIONS_BY_TABLE` map at
[src/renderer/api/useRemoteApply.ts](src/renderer/api/useRemoteApply.ts)
and [src/renderer/api/ipcCache.ts](src/renderer/api/ipcCache.ts), and
added `app.on('browser-window-focus', triggerSyncPull)` to drop cross-
device latency from up-to-60s to ~1s on focus. 33 new tests; existing
suites untouched. **Original scope below preserved for archaeology.**

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

### T16 — Mobile: surface impromptu (no-cal-event) meetings somewhere ✅ SHIPPED
**Reconciled 2026-06-21:** SHIPPED — "My Recordings" via `mobile/components/ImpromptuRecordingsSection.tsx` on the calendar tab, backed by gateway `GET /meetings/impromptu`.

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

### T13 — Mobile: gracefully surface non-401 errors from handleEventPress ✅ shipped
**STATUS:** ✅ shipped. Inline `ErrorBanner` (auto-dismisses after 4s)
implemented in
[mobile/app/(tabs)/calendar.tsx:73-78](mobile/app/(tabs)/calendar.tsx#L73-L78)
+ render at line 390; set via `setBannerMsg` in `handleEventPress`
catch block at lines 304-306. Chose a banner over a toast system to
avoid pulling a third-party dependency.

**What:** `mobile/app/(tabs)/calendar.tsx`'s tap handler currently
`console.error`s non-reauth errors but doesn't show anything to the
user. A 5xx during prepareMeetingFromCalendarEvent looks like a no-op
tap.
**Fix:** show a small toast / inline error banner. Reuse whatever
toast system gets adopted in M6.
**Why:** Caught during E2E — 400s on early taps were invisible.

### T-MC.3-pull — Desktop pull-side for `company_flagged_files` (multi-desktop V2)
**What:** Mirror the T14 / T39 pattern for flagged files. Add
`applyRemoteCompanyFlaggedFiles` + `COMPANY_FLAGGED_FILES_SPEC` in
[src/main/services/sync-remote-apply.ts](src/main/services/sync-remote-apply.ts)
(`hasUserId: true`, no INNER JOIN needed — table is user-scoped via
`user_id` column directly). Add `companyFlaggedFiles` to the gateway
`/sync/pull` parallel queries in
[api-gateway/src/routes/sync.ts](api-gateway/src/routes/sync.ts).
Wire `onCompanyFlaggedFilesApplied` callback + IPC fanout
(`COMPANY_FLAGGED_FILES_REMOTE_APPLIED`) in
[sync-pull.service.ts](src/main/services/sync-pull.service.ts) +
[sync-bootstrap.ts](src/main/services/sync-bootstrap.ts). Apply order:
AFTER `org_companies` (parent FK).
**Why:** MC.3 (gateway-side parsed_text in mobile chat) shipped fully
on the push side — desktop writes extracted_text, outbox carries it to
Neon, gateway includes it in chat context. The pull-side primitive
only matters once a second desktop or teammate enters the picture.
Until then, the same single desktop is both the writer AND the reader,
so it has the data locally.
**Pros:** Closes the loop for multi-device — teammate-flagged files
appear on your desktop within one pull tick.
**Cons:** ~half day; zero user-visible value at single-desktop / single-
user beta scale.
**Effort:** S (~half day, mostly mechanical — same TableSpec shape as
chat_sessions in commit `6a8e702`).
**Tests:** extend `src/tests/sync-remote-apply-additional-tables.test.ts`
with insert / LWW skip / LWW update / FK-respect cases. Extend
`api-gateway/test/sync-pull.test.ts` with response-shape + cross-user
assertions (mirrors the chat tests from commit `6a8e702`).
**Priority:** P3.
**Depends on / blocked by:** First multi-desktop or multi-user signal.

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

### T40 — Lazy-load transcripts entirely (post-finalization egress) ⚠️ PARTIAL
**Reconciled 2026-06-21:** PARTIAL — in-progress meetings already suppress `transcript_segments` on pull (`api-gateway/src/routes/sync.ts`), but finalized meetings still ship the full transcript inline; no separate on-demand `GET /meetings/:id/transcript` route. The egress-saving lazy-load remains OPEN.
**What:** Drop `transcript_segments` from `/sync/pull` always (not just for
in-progress meetings); add a new `GET /meetings/:id/transcript` route; have
desktop renderer and mobile detail screen fetch transcripts on-demand when
the user opens a meeting.
**Why:** First-launch sync (`since=0`) and any post-finalization metadata
edit (notes, attendees, title) currently re-ships the full transcript. For
a user with 500 finalized meetings, first launch pulls ~30 MB+ of
transcript data; subsequent edits each re-ship one full transcript. The
in-progress fix that just shipped (the plan referenced below) closes the
per-minute recording bleed but leaves the per-event-touch bleed.
**Pros:** ~95% reduction on meeting-row payload across the board.
Transcripts only travel the wire when actually viewed (rare for most
historical meetings). Sidesteps the "row-level granularity is too coarse
for fat columns" architectural smell.
**Cons:** Real surface-area change — new route, new fetch hook in renderer
+ mobile, decision about whether desktop SQLite stores transcripts at all
or always fetches. Touches 6–10 files. Introduces a new failure mode
(offline transcript view stops working unless we keep a local cache).
**Context:** Natural follow-up to the in-progress suppression. Defer until
post-deploy egress measurement shows whether the in-progress fix alone is
sufficient. If Neon egress drops to <2 GB/month, this may not be needed at
all. Start by reading `applyRemoteMeetings` (the `transcript_segments`
column would need to be removed from the upsert), then design the
on-demand fetch + caching policy. Plan:
`~/.claude/plans/does-sync-pull-really-need-vectorized-hickey.md`.
**Depends on / blocked by:** In-progress fix shipped. Post-deploy egress
data to decide if the work is justified.

### T41 — Origin-device filter on `/sync/pull` meetings query
**What:** Add `AND COALESCE(origin_device_id, '') != :requestingDeviceId`
(or equivalent) to the `/sync/pull` meetings query (and other owned
tables). Requires populating an `origin_device_id` column when writes hit
Neon. Stops the recording device from re-downloading any of its own
writes — not just transcript_segments.
**Why:** The desktop already sends its `deviceId` in pull requests
([src/main/services/sync-pull.service.ts:228](src/main/services/sync-pull.service.ts#L228)),
but the gateway query at
[api-gateway/src/routes/sync.ts:480-487](api-gateway/src/routes/sync.ts#L480-L487)
ignores it. `applyRemoteMeetings` uses it downstream to skip *applying*
but only after the bytes are already on the wire. Pure egress waste for
the writer.
**Pros:** Eliminates self-download across the board (not just transcripts)
— applies to notes, contacts, companies, every owned table. Symmetric
with the existing apply-side skip logic. Architecturally clean.
**Cons:** Needs an `origin_device_id` column on every owned table (or a
writers/outbox-origin tracking table) and gateway-side write logic to
populate it. Migration + schema change. Touches every owned-table sync
route. For the dominant case (transcript bytes during recording), the
in-progress fix already addresses it, so the marginal value is harder to
quantify.
**Context:** Architecturally pure solution; the in-progress fix is the
surgical one. Worth doing if non-transcript egress dominates after the
in-progress fix — e.g., heavy note/contact editing on one device that
the same device redownloads. Start by checking whether the outbox already
tracks origin device (it might, given the SyncAgent design); if so, the
column may be derivable rather than added fresh. Plan:
`~/.claude/plans/does-sync-pull-really-need-vectorized-hickey.md`.
**Depends on / blocked by:** In-progress fix shipped, and post-deploy
egress measurement. Also blocked by understanding whether outbox/origin
tracking exists in current schema.

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

### Mobile companies list: watch for logo flicker on scroll/cold load
**What:** If the companies list shows visible flicker as new rows scroll into view (or on cold app load), swap `CompanyLogo` from RN's built-in `Image` to `expo-image` (built-in disk cache + transition animations) or prefetch all visible Clearbit URLs in the list query's `onSuccess`.
**Why:** Speculative — flagged during the 2026-05-25 plan-eng-review of the mobile-logos PR. RN's `Image` only memory-caches per process, so cold app launches re-fetch every favicon from Clearbit's CDN. At single-firm scale (<500 companies) this should be fine; we picked the simplest path and left optimization for the moment it becomes user-visible.
**Pros:** Removes any list-scroll flicker that does show up; expo-image is a small-surface drop-in.
**Cons:** Extra dependency (`expo-image`) + native rebuild; or extra bookkeeping in the list query if we prefetch manually. Probably never needed for a single firm.
**Context:** `CompanyLogo` lives at [mobile/components/CompanyLogo.tsx](mobile/components/CompanyLogo.tsx); the list query is at [mobile/app/(tabs)/companies.tsx](mobile/app/(tabs)/companies.tsx). The user-facing symptom would be a brief slate placeholder → logo flash as each row scrolls in.
**Effort:** S
**Priority:** P3 (latent — open only if observed)
**Depends on:** None.

---

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

## P1 — Layout Persistence ⚠️ PARTIAL
**Reconciled 2026-06-21:** PARTIAL — the infra exists (`user_preferences` table with lamport in `packages/db/src/schema/settings.ts`; desktop `user-preferences.ipc.ts` + `preferences.store.ts` hydrate from DB), but the layout-specific prefs (`fieldPlacements`/`addedFields`/`sectionOrder`) aren't confirmed wired from renderer state → `USER_PREF_SET` → outbox, and there's no mobile pull/edit surface. Treat the plumbing as shipped, the field-level wiring + mobile side as OPEN.

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

## P1 — Stress-test (Phase 2 follow-ups) ⚠️ PARTIAL
**Reconciled 2026-06-21:** PARTIAL — Phase 1 (read-only `StressTestReportViewer` + Reports button + toast) SHIPPED; Phase 2 (checkbox-select findings + "Apply N selected" → memo rewrite) is OPEN (no selection state in the viewer, no apply IPC path).

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

---

## Speaker attribution follow-ups (post tap-to-relabel)

### SP.1 — Tighten proper-noun corrector against near-collisions
**What:** Raise `SINGLE_WORD_THRESHOLD` in `src/main/utils/proper-noun-corrector.ts:21` from 0.92 → 0.96, or add an edit-distance guard that skips corrections where the candidate is within 1 character of another known CRM name.
**Why:** Cause 2 of the original "Cyggie thinks I'm Andy" bug. Even with the recording-side fix and the tap-to-relabel UX shipped, the proper-noun corrector still silently rewrites "Sandy" → "Andy" in transcript text whenever "Andy" exists in CRM (`JW("sandy","andy") = 0.933`, above the 0.92 threshold).
**Pros:** Eliminates the silent transcript rewrite. Downstream summaries/chat stop attributing "Sandy" lines to "Andy".
**Cons:** May reduce some legitimate corrections of misspellings on shorter names.
**Context:** Discovered during the relabel UX work. Proper-noun corrector uses Jaro-Winkler; sandy/andy is a JW=0.933 collision. The threshold was originally tuned without accounting for adjacent-name collisions.
**Effort:** S
**Priority:** P2
**Depends on:** Nothing.

### SP.2 — Auto-link to CRM contact on attendee selection by email match
**What:** When a user picks an attendee from the speaker picker, look up `meeting.attendeeEmails[i]` (index-correlated with `meeting.attendees`) against `contacts.email` and `contact_emails.email`. If a match is found, also call `MEETING_TAG_SPEAKER_CONTACT` to link the speaker to that contact, not just rename.
**Why:** Removes a manual step — today, picking an attendee renames only. If a CRM contact for that attendee exists, the user has to scroll the picker's Contacts section and pick again to get the link.
**Pros:** One-tap rename + link in the common case where the attendee is already a known contact.
**Cons:** One extra IPC roundtrip; risk of surprising the user if the email match isn't obvious.
**Context:** New `useCombinedSpeakerPicker` hook returns `{ kind: 'attendee' | 'contact', ... }`. Dispatch in `handleSpeakerPickerSelect` would need to check email before deciding which IPC to call.
**Effort:** S
**Priority:** P3
**Depends on:** Tap-to-relabel UX (shipped).

### SP.3 — Loudness-based recorder identification in diarization mode
**What:** When `channelMode === 'diarization'` in `packages/services/src/recording/RecordingSession.ts` (single-channel recordings, typically in-person meetings), compute per-speaker RMS audio energy across the captured PCM and label the loudest speaker cluster as the local recorder (low confidence; user can override via the speaker picker).
**Why:** Reduces manual relabeling in in-person meetings where multichannel isn't available. Today the recording-side fix falls back to "Speaker N" labels in diarization mode — correct but mute. Loudness is a reasonable heuristic since the recorder is closest to the mic.
**Pros:** Recovers some auto-attribution in the mode where we currently can't identify anyone.
**Cons:** Requires holding raw PCM through the Deepgram pipeline + timestamp correlation per speaker. Heuristic will be wrong sometimes (recorder talks less than guest); the relabel UX is the safety net.
**Context:** Earlier conversation discussed this; deferred until the relabel UX shipped first so users have a way to fix wrong guesses.
**Effort:** M
**Priority:** P3
**Depends on:** Tap-to-relabel UX (shipped).

## P2 — Mobile reliability / auth

### Reconnect Google on Gmail / notes / meeting-detail screens

**What:** Replicate the calendar tab's `REAUTH_REQUIRED → "Reconnect Google"` UX on every other mobile screen that surfaces this error code.
**Why:** Calendar shipped a real escape hatch (this PR — `CalendarReauthState` + `reauthorizeGoogle()` helper in `mobile/lib/auth/oauth.ts`). The api client comment at [mobile/lib/api/client.ts:140-144](mobile/lib/api/client.ts#L140-L144) mentions "~8 screens" that surface REAUTH_REQUIRED. The other ~7 still dead-end at "Try again."
**Pros:** Consistent UX across the app. The helper is already extracted, so each site is ~5 lines + an RNTL test using the same mock pattern as `mobile/components/__ui-tests__/CalendarReauthState.test.tsx`.
**Cons:** Need to audit which screens surface the error today (grep for `ApiError` from Google-backed endpoints — Gmail, notes, meeting-detail, contacts when populated from Gmail, etc.). Each gets its own UI test.
**Context:** `needsGoogleReauth(error)` + `<CalendarReauthState onComplete={…} />` are the building blocks. For non-calendar screens we may want to rename the component to `<GoogleReauthState>` to avoid implying it's calendar-specific.
**Effort:** S per screen × N screens
**Priority:** P2
**Depends on:** Nothing — helper already exists.

### Gateway-side enforcement of userId match on /auth/google/callback

**What:** Defense-in-depth — gateway refuses to mint a session if the resolved Google userId doesn't match the userId that initiated the OAuth flow.
**Why:** This PR adds a mobile-side userId mismatch check in `CalendarReauthState` so a user who re-consents with a different Google account doesn't silently swap identity. The gateway should enforce the same invariant so a hand-rolled or older client benefits from the protection too.
**Pros:** Single point of enforcement that all current and future clients (mobile, desktop, future web) inherit. Closes the gap where two different clients could end up swapping users via the same callback infrastructure.
**Cons:** Requires the gateway to track which user initiated each `state` token (currently the `oauth_pending` row has no user_id column). New migration + write path on `/auth/google/start` + check path on `/auth/google/callback`.
**Context:** `/auth/google/start` already accepts an optional auth header after this PR (used to inject `login_hint`). Extending it to *record* the initiating userId against the `oauth_pending` row is the natural next step; the callback already has the resolved userId post-token-exchange.
**Effort:** M
**Priority:** P2
**Depends on:** Nothing — purely additive.

---

## Add email editing UI to the mobile contact detail page

**What:** Build an edit affordance on `mobile/app/contacts/[id].tsx` that lets
mobile users add/change/remove emails on a contact, including the new
"Email 2" alternate slot. Today the mobile detail page only renders the
primary email and there is no contact-edit form on mobile at all.

**Why:** Desktop now ships Email 2 (secondary email address) so a contact can
be associated with two addresses and calendar attendee sync dedups them to a
single avatar. A contact synced to mobile already carries both emails in the
returned `ContactDetail.emails: string[]`, but mobile users can't add or
maintain Email 2 themselves. The asymmetry is visible to anyone managing
contacts on phone — they'll be able to *see* a secondary email someone added
on desktop but unable to add or correct one from mobile.

**Pros:** Closes the mobile/desktop edit parity gap. Surface area is small
because the backend (`contact_emails` table, IPC handlers on desktop) is
already done — what's missing is a gateway endpoint and a mobile UI surface.

**Cons:** Mobile contact-edit form does not exist yet — this is a new UI
surface rather than an extension of an existing one. Likely an afternoon
of work plus design pass.

**Context:** Touchpoints:
- `mobile/lib/api/contacts.ts` `updateContact` currently only handles
  `keyTakeawaysUserNote`. Needs new mutations for add/update/remove email.
- `api-gateway/src/routes/contacts.ts` needs PUT/PATCH endpoints that
  mirror the desktop IPC handlers (`CONTACT_ADD_EMAIL` /
  `CONTACT_UPDATE_EMAIL` / `CONTACT_REMOVE_EMAIL`) and write through to
  the same Postgres `contact_emails` table.
- Sync: writes from gateway need to land in desktop SQLite via the
  existing outbox/pull cycle.

**Effort:** M (gateway endpoints + mobile form + sync verification).
**Priority:** P3.
**Depends on:** Desktop Email 2 shipping (2026-05-29 on
`feat/transcription-eval-cli`).

---

## Expand the on-demand company-extraction eval to notes/emails/multi-meeting paths

**What:** Extend the `npm run eval:company-extraction` harness (introduced
alongside the VC-pitch LLM extractor fix) to cover the three other
enrichment paths that share `buildCompanyEnrichmentProposal`:
note-based enrichment (`getCompanyEnrichmentProposalsFromNotes`),
email-based enrichment (`getCompanyEnrichmentProposalsFromEmails`), and
multi-meeting enrichment (`getCompanyEnrichmentProposalsFromMeetings`).
Add 2–3 captured fixtures per path with annotated expected proposals.

**Why:** The 2026-05-29 fix that swapped regex extraction for the LLM
extractor on the VC-pitch path also strengthened the shared system prompt
inside `buildCompanyEnrichmentProposal`. That prompt change silently
affects the other three enrichment callers — but the new eval suite only
exercises the VC-pitch path. Without per-path eval fixtures, a future
prompt iteration can quietly regress, say, note-based enrichment without
anyone noticing until a user complains.

**Context:** Touchpoints:
- `packages/services/src/company-summary-sync.service.ts` — the four
  call sites: `getVcSummaryCompanyUpdateProposals`,
  `getCompanyEnrichmentProposalsFromNotes` (line 886),
  `getCompanyEnrichmentProposalsFromEmails` (line 923),
  `getCompanyEnrichmentProposalsFromMeetings` (line 833).
- `src/tests/evals/company-extraction-eval.ts` — the on-demand harness
  to extend; currently fixtures-of-summaries only. Each new path's
  fixtures need a different shape (notes are short-form, emails come
  with subject + snippet, multi-meeting concatenates dated blocks).
- `npm run eval:company-extraction` in `package.json` — extend to take
  a `--path=vc|notes|emails|meetings|all` flag or split into four scripts.
- The shared prompt to guard: `buildCompanyEnrichmentProposal` line ~605
  (the strict "do not infer from comps" guidance).

**Pros:** Closes the cross-path regression gap. Gives a single command
that, before any future prompt change, can answer "does this still work
across all four flows?"

**Cons:** Fixture maintenance (need real, anonymized notes / emails /
multi-meeting summaries — more work to source than VC pitches). On-demand
only, so it has to be remembered.

**Effort:** S–M (mostly fixture sourcing; the harness already exists).
**Priority:** P3.
**Depends on:** VC-pitch eval harness landing first (2026-05-29 on this
PR).

---

## Add search-when-5+-options input to the shared `OptionListPopover`

**What:** Render a small search input at the top of `OptionListPopover`
when `options.length >= 5`. Filter the visible list as the user types.
Arrow keys navigate filtered results; the type-accumulator shortcut only
kicks in when the search input is unfocused.

**Why:** Custom-field select columns can grow to dozens of options.
Without a filter, finding an option in a long list requires scrolling
past the entire list or relying on first-letter type-jump (which fails
when many options share a prefix). `PropertyRow.tsx` already does this
for multiselect; the table popover should match for consistency once
`OptionListPopover` is the shared primitive.

**Context:** Reference [PropertyRow.tsx:468-480](src/renderer/components/crm/PropertyRow.tsx#L468-L480)
for the existing implementation. The shared `OptionListPopover`
introduced by the three-click-dropdown PR is the natural home. Wire so
that ArrowUp/Down move within the filtered set, Enter picks the
currently-active filtered item, Esc closes, and the type-accumulator
(used when no search box is rendered, i.e. <5 options) is bypassed when
the search input has focus.

**Pros:** Closes a UX gap for large custom-field option lists; one less
reason to maintain a separate PropertyRow popover indefinitely.

**Cons:** Adds focusable UI inside the popover even when not strictly
needed; need careful focus management so the picker doesn't fight with
the cell-level type-accumulator.

**Effort:** S (~½ day; the logic exists in PropertyRow and just needs
extraction into the shared component).
**Priority:** P3.
**Depends on:** Shared `OptionListPopover` landing (the three-click
dropdown plan: `when-the-user-clicks-cheeky-candy.md`).

---

## Bring multiselect custom-field cells in tables to parity with PropertyRow

**What:** Today, multiselect custom-field cells in the Contacts and
Companies tables fall through to a plain text input — no chips in
display, no popover in edit. Give them the same chip-display + popover-
with-checkboxes UX that `PropertyRow.tsx` already provides for
multiselect in the right-hand property panels.

**Why:** A user creating a custom multiselect field expects parity with
the property panel. Today the table silently degrades the experience for
the same field — chips render correctly in the panel, but the same field
in the grid is a comma-separated text input. Pre-existing gap surfaced
during the three-click dropdown review (not introduced by it).

**Context:** Touchpoints:
- [EditableCell.tsx:306](src/renderer/components/company/EditableCell.tsx#L306)
  gates the dropdown branch on `col.type === 'select'`; multiselect
  falls to the text-input branch at line 328.
- [ContactTable.tsx:784](src/renderer/components/contact/ContactTable.tsx#L784)
  similarly checks `col.type === 'select'` for the chip cell;
  multiselect renders no chips.
- [CompanyTable.tsx](src/renderer/components/company/CompanyTable.tsx)
  has the same gating.
- Reference [PropertyRow.tsx:497-520](src/renderer/components/crm/PropertyRow.tsx#L497-L520)
  for the checkbox option row pattern to lift into the shared popover.

Plan: (a) display layer — split a comma-joined `cellValue` into multiple
chips, reuse the same `chipStyle()` helper; (b) edit layer — extend the
shared `OptionListPopover` with a `mode: 'single' | 'multi'` prop that
renders checkboxes when multi and defers commit until popover close;
(c) plumb the three-click pattern from the dropdown PR through to
multiselect cells too.

**Pros:** Closes a real feature gap. Lets the shared `OptionListPopover`
absorb the multiselect mode once, instead of leaving PropertyRow with
its own multiselect path.

**Cons:** New display + edit code in EditableCell and both chip-cell
paths; touches more files; needs design input on chip wrapping when a
cell holds many selected values (truncate? +N indicator?).

**Effort:** M (~1-2 days; mostly UI design + plumbing, no new IPC).
**Priority:** P2.
**Depends on:** Shared `OptionListPopover` landing (the three-click
dropdown plan: `when-the-user-clicks-cheeky-candy.md`).

---

## Migrate `ChipSelect` onto the shared `OptionListPopover`

**What:** Audit [ChipSelect.tsx](src/renderer/components/crm/ChipSelect.tsx)
against the shared `OptionListPopover` introduced by the three-click
dropdown plan. Reconcile any behavioral differences (extend the shared
primitive or document why ChipSelect needs to stay separate), then
migrate `ChipSelect` consumers (Pipeline cell + inline property
contexts) to use the shared popover.

**Why:** After the three-click dropdown PR lands, the codebase will have
two unified dropdowns (`EditableCell` + `PropertyRow` both on
`OptionListPopover`) and one orphan (`ChipSelect`). Without this
migration, drift starts immediately: any keyboard/UX improvement to
`OptionListPopover` will silently *not* apply to wherever `ChipSelect`
still lives, and users will notice the inconsistency.

**Context:** Step 1 is the audit — diff `ChipSelect` behavior against
`OptionListPopover` to identify unique features it provides (inline
trigger vs portal, colored-chip rendering rules, anything custom). Some
of those may already be supported by the shared primitive; some may need
to be added; some may justify keeping `ChipSelect` separate. Document
the decision in the migration commit. `InvestorChipsCell` is explicitly
NOT a candidate (chip search + dedup is a meaningfully different data
model).

**Pros:** Final piece of dropdown unification — one keyboard model, one
focus style, one "+ Add option" flow across the app.

**Cons:** Audit-first means uncertain scope; ChipSelect may have
features that require extending the shared primitive, which compounds
risk.

**Effort:** M (~1-2 days incl. audit + migration + tests).
**Priority:** P3.
**Depends on:** Shared `OptionListPopover` landing (the three-click
dropdown plan: `when-the-user-clicks-cheeky-candy.md`).

## Resize cyggie-gateway Fly VM from shared-cpu-1x/512MB to shared-cpu-2x/1GB

**Trigger:** When 3+ Red Swan partners are actively using the Slack
bot, OR when Sentry shows any OOM/SIGABRT on `cyggie-gateway`, OR when
average memory utilisation crosses 70% (whichever fires first).

**Action:**
```
fly scale vm shared-cpu-2x --memory 1024 -a cyggie-gateway
```
Fly recreates both HA machines at the new size. ~30s of unavailability;
idempotent.

**Why:** Plan slice 1 acceptance criterion (External Agents V1) called
for this before launch. Deferred 2026-06-05 because:
1. V1 traffic is Sandy-alone smoke-testing → 1-2 concurrent asks max.
2. Auto-suspend keeps machines off most of the day → cost is moot.
3. Resize is non-destructive and runtime-safe → can do it live when load
   signals warrant.

The known failure mode this protects against (documented in
[`api-gateway/src/app.ts:51-58`](api-gateway/src/app.ts#L51-L58)) is the
2026-05-23 OOM-SIGABRT inside V8 JSON parsing when a 50MB SyncAgent push
collided with chat + agent loops in 512MB. Slack-bot peak load adds the
same memory pressure profile; once partner concurrency grows, 512MB is
too tight.

**Cost:** ~$2/mo per machine extra ($4/mo total, negligible vs Anthropic
spend per query).
**Effort:** S (one CLI command + ~30s downtime).
**Priority:** P2 (no impact today; load-triggered).
**Owner:** Sandy.

## Multi-entity AI Chat — attach the context picker to meeting-anchored chats

**What:** Extend the "+ Add context" chip row (`ContextChipRow`) so it also
appears in meeting-anchored chats. Today the picker shows only for
company/contact/global chats; a chat opened from a meeting keeps the legacy
behavior (its own transcript, no attach control). See
[`ChatPanelRoot.tsx`](src/renderer/components/chat-panel/ChatPanelRoot.tsx)
(`deriveCurrentKind` short-circuits `meeting` sessions before the entities
branch) and the `canAttach` gate in
[`PanelComposer.tsx`](src/renderer/components/chat-panel/PanelComposer.tsx).

**Why:** Consistency. A user mid-conversation about a meeting may want to pull
in a company/contact's full context without starting a new chat. The reported
pain (company/contact context that couldn't be re-added) is fully solved; this
is the inverse, lower-frequency direction.

**Context:** The multi-entity chat shipped 2026-06-10 (attached_context_entities
on chat_sessions, `queryEntities` deduped builder). The meeting kind uses a
separate `pageContext.meetingId` routing path and a distinct session contextId
scheme; folding it into the entities model means deciding whether the meeting
itself becomes an attachable entity or stays the session anchor with entities
layered on top. Start in `deriveCurrentKind`.

**Effort:** M. **Priority:** P3 (nice-to-have; no reported demand yet).
**Owner:** Sandy.

## Multi-entity AI Chat — contact + lone-contact context-size estimation

**What:** Give the chat context-size banner (`ChatContextSizeBanner`) a size
figure for contacts. Today `CHAT_CONTEXT_SIZE_PREFLIGHT_MULTI`
([`chat.ipc.ts`](src/main/ipc/chat.ipc.ts)) aggregates **company** ids only —
contacts have no size preflight — so a contact-only chat shows no meter, and a
mixed chat's meter omits contact-derived meetings/emails/notes.

**Why:** The banner is meant to show "what the LLM will see per message." With
contacts excluded it under-reports for contact-heavy chats. Low stakes (the
deduped multi-entity builder still bounds the real context via caps), but the
meter is misleading when contacts dominate.

**Context:** Add a contact estimator (meetings + emails + notes char count,
mirroring the company `estimateChatContext` inputs) and feed contact ids into
the multi preflight. Ideally share the same union/dedup gathering as
`buildUnifiedEntitiesContext`
([`entities-chat.ts`](packages/services/src/llm/entities-chat.ts)) so the meter
matches the prompt exactly (companies already do this).

**Effort:** S–M. **Priority:** P3. **Owner:** Sandy.

---

## Refactor RECORDING_START to a single options object

**What:** Replace the positional argument list
`(title, calEventId, appendToMeetingId, meetingUrl)` on the `RECORDING_START`
IPC handler with one `{ title?, calEventId?, appendToMeetingId?, meetingUrl? }`
options object, updating the handler
([`recording.ipc.ts`](src/main/ipc/recording.ipc.ts)) and the ~7 renderer call
sites ([`App.tsx`](src/renderer/App.tsx),
[`Layout.tsx`](src/renderer/components/layout/Layout.tsx),
[`useMiniCalendarActions.ts`](src/renderer/hooks/useMiniCalendarActions.ts),
[`Dashboard.tsx`](src/renderer/routes/Dashboard.tsx),
[`LiveRecording.tsx`](src/renderer/routes/LiveRecording.tsx),
[`MeetingList.tsx`](src/renderer/routes/MeetingList.tsx),
[`MeetingDetail.tsx`](src/renderer/routes/MeetingDetail.tsx)).

**Why:** The meeting-window duplicate fix (the notification "Join Meeting"
double-open) pushed the parameter count to 5, forcing `undefined` placeholders
at call sites like `invoke(ch, title, calEventId, undefined, meetingUrl)` —
fragile and easy to mis-order. An options object is explicit and safe to extend
when the next optional field appears.

**Context:** The notification path now forwards the calendar event's
`meetingUrl` as a fallback so the URL still opens once when the recording-side
`getEventById` lookup can't resolve it (calendar disconnected between
notification show and click). That fallback is what added the 5th positional
arg. Only `App.tsx`'s notification path passes it today; all other call sites
leave it undefined. Start at the handler signature and let the type error drive
the call-site updates.

**Effort:** S. **Priority:** P3. **Depends on / blocked by:** Nothing.

---

## Write the OAuth consent E2E (the last deferred MCP/OAuth tests)

**What:** Author `api-gateway/test/oauth-e2e.test.ts` covering the four OAuth
cases still skipped in
[`oauth-unit.test.ts`](api-gateway/test/oauth-unit.test.ts): full
`register → authorize+PKCE → consent → token exchange → /mcp 200`,
`refresh_token` rotation (old token invalid), refresh-token reuse → chain
revocation + Sentry alert, and a `client_credentials` grant. Add Playwright +
chromium (gateway-project dev dep) for the browser-driven consent step.

**Why:** These are the only 4 `test.skip`s left in the whole suite. They were
deferred because you can't obtain a refresh token without the consent
round-trip (browser), and `client_credentials` needs a separately-provisioned
confidential client — neither is expressible from the headless harness.

**Context:** The rest of the MCP/OAuth surface is now covered headlessly
against the local embedded Postgres (mcp-smoke per-tool + seed-backed tests,
`/oauth/reg` 429). Reuse the existing `mintTestToken` + `app.inject` +
`callTool` helpers in `api-gateway/test/_helpers/`. The consent leg needs a
test Cyggie user with a server-side session cookie; the provider's
reuse-detection lives in `api-gateway/src/oauth/reuse-detection.ts` and the
events it fires are in `api-gateway/src/oauth/hooks.ts`.

**Effort:** M. **Priority:** P3. **Depends on / blocked by:** Playwright/chromium
added to the gateway test project.

---

## Add CI (GitHub Actions) now that the gateway suite is hermetic

**What:** Add a GitHub Actions workflow that runs `npx vitest run` on PRs. The
gateway test project boots its own ephemeral Postgres
([`api-gateway/test/global-setup.ts`](api-gateway/test/global-setup.ts)) and is
fully hermetic — it runs with **zero `.env.local`** (every required env var has
a dummy in [`vitest.config.ts`](vitest.config.ts) `test.env`), so no secrets
need wiring.

**Why:** There's no CI today; nothing guards `main` against regressions on
push. The whole point of making the suite hermetic was to unlock this — it's
the payoff.

**Context:** On CI, decide the embedded-Postgres engine: either cache the
`embedded-postgres` PG17 binary download, or switch the gateway project to
`@testcontainers/postgresql` (Docker is native in GH Actions) — revisit the
engine choice (eng-review Issue 4) specifically for CI. The non-gateway
`default` project needs no DB. `node scripts/check-repo-imports.mjs` should run
as a separate step.

**Effort:** S–M. **Priority:** P2. **Depends on / blocked by:** Nothing (the
hermetic suite is already on `main`).

## DB-backed integration test for dashboard `listRecentActivity`

**What:** Stand up a `better-sqlite3` `:memory:` test harness (run migrations,
seed companies/notes/meetings/emails) and assert
[`listRecentActivity`](packages/db/src/sqlite/repositories/dashboard.repo.ts)
end-to-end: notes appear/disappear by `filter.types`; the `'none'` stage
includes null/empty-stage companies *and* untagged notes; tagged notes respect
stage/entity-type filters; and `getActivityFilter` accepts `'none'` (rather than
silently stripping it).

**Why:** The current unit tests in
[`dashboard-filter.test.ts`](src/tests/dashboard-filter.test.ts) cover only the
pure SQL-string builders (`buildCompanyConditions`, `buildCompanyExistsClause`,
`buildNoteWhereClause`). The actual query assembly, the `getActivityFilter`
validation branch, and the union/JOIN behavior have no automated coverage — a
regression there (e.g. `'none'` getting dropped from validation) would be a
**silent** failure: the chip toggles in the UI but the result set never changes.

**Context:** Added alongside the "Notes type + None stage + untagged-notes"
change (feat/mobile-meeting-view-fixes). No DB-backed sqlite repo tests exist in
the repo today — this would be the first, so it also establishes the harness
pattern (migrations + seed helpers) other repo tests can reuse. Start from
`packages/db/src/sqlite/connection.ts` for how the DB is opened.

**Depends on / blocked by:** Nothing; independent of the shipped UI change.

**Effort:** M (mostly harness setup). **Priority:** P3. **Owner:** Sandy.

## Notes — desktop parity for firm-shared reads

**What:** Extend `GET /sync/pull` (and the desktop apply path) so that
firm-shared notes owned by *other* firm members land read-only in each
desktop's local SQLite, closing the asymmetry where mobile shows the firm's
collective notes but the desktop shows only your own.

**Why:** The private-notes feature (shipped) made firm members' tagged,
non-private notes visible to each other — but only through the gateway, which
mobile consumes. Desktop SQLite sync stayed strictly per-user (`/sync/pull`
filters by `user_id = me`), so the same user sees different note sets on
desktop vs mobile. This is the deliberate V1 scope cut; closing it is the main
step toward true desktop multiplayer.

**Context:** The visibility contract already exists as one function —
`noteVisibilityFilter(user)` in
[`api-gateway/src/notes/visibility.ts`](api-gateway/src/notes/visibility.ts).
The hard part is the *ownership model*: pulled foreign rows must be stored
read-only and must NOT re-enter the desktop outbox (`withSync`) or they'd
ping-pong back and the gateway LWW would reject them. The pull-apply primitive
is `applyRemoteNotes` /`upsertNoteRow` in
[`src/main/services/sync-remote-apply.ts`](src/main/services/sync-remote-apply.ts);
it already bypasses the outbox, but it assumes every applied row is owned by
the local user. Needs a non-owned marker (e.g. a `read_only` / `owner_user_id`
column on the local notes table) so the renderer can render but not edit, and
so the sync engine never enqueues them. Also requires the gateway pull query to
return firm-shared rows (currently `notes.userId = me` only) using the same
visibility predicate.

**Depends on / blocked by:** Builds on the shipped private-notes feature
(`is_private` column + `noteVisibilityFilter`). No hard blockers.

**Effort:** L. **Priority:** P2. **Owner:** Sandy.

## Notes — let AI + MCP reason over firm-shared notes ✅ SHIPPED

**Status:** SHIPPED (firm-brain notes workstream). `cyggie_get_notes` and the
notes path of `cyggie_search` now apply `noteVisibilityFilter` (+ a `users`
inner-join) instead of `eq(notes.userId, me)`, so a teammate's tagged,
non-private notes reach the Slack bot, `cyggie_ask`, and MCP answers; private
and untagged notes stay owner-only. `firmId` is threaded from the verified
token (MCP) or the users row (Slack, via `src/shared/resolve-firm.ts`); a null
firm falls back to owner-only. The **prompt-injection boundary** lives in
[`api-gateway/src/mcp/untrusted.ts`](api-gateway/src/mcp/untrusted.ts): every
note body the tools emit is fenced in `<note_content>` (forged close-tags
defanged) under a banner telling the model to treat it as data, never
instructions. Teammate notes also carry an author byline for provenance. Leak
tests: `api-gateway/test/mcp-notes-firm-shared.test.ts` (+ unit coverage of the
boundary in `mcp-unit.test.ts`). No MCP tool name/schema/error-code changed —
output-additive only.

**Follow-up — ✅ SHIPPED:** `cyggie_search`'s companies / contacts / meetings
buckets are now firm-scoped too (parity with REST WS1): companies fully
firm-shared via `companyVisibilityFilter`, contacts/meetings via
`entityVisibilityFilter` (shared unless `is_private`), null firm → owner-only.
Leak tests in `api-gateway/test/mcp-search-firm-scope.test.ts`. The MCP
`cyggie_get_company` / `_get_contact` / `_get_meeting` single-entity tools were
NOT touched and remain owner-only — a small further slice if firm-wide
single-entity lookups are wanted.

**What (original):** Route the AI/RAG context builder and the `cyggie_get_notes`
MCP tool through `noteVisibilityFilter` so they surface firm-shared
(tagged, non-private) notes in addition to the caller's own — unlocking
"ask the firm brain" across the partnership's collective note-taking.

**Why:** The private-notes feature enforces visibility at the two REST routes
(`GET /notes`, `GET /notes/:id`). The MCP read path
([`api-gateway/src/mcp/tools/get-notes.ts`](api-gateway/src/mcp/tools/get-notes.ts))
and any gateway/mobile AI context builder still scope strictly to `user_id = me`
— so the firm's shared notes are invisible to the Slack bot and to AI answers.
This is intentional in V1 (own-only = no leak), but it leaves the biggest payoff
of collective memory on the table.

**Context:** The single enforcement contract already exists:
`noteVisibilityFilter(user)` in
[`api-gateway/src/notes/visibility.ts`](api-gateway/src/notes/visibility.ts).
Swap the `eq(notes.userId, user.sub)` filter in `get-notes.ts` (and the RAG
context query) for the visibility predicate + the `users` inner-join (see how
`api-gateway/src/routes/notes.ts` does it). **Important — threat model first:**
once a teammate's note content can enter *another* user's LLM context, a
malicious or careless note becomes a prompt-injection vector. Add the injection
boundary (delimit/escape note bodies in the prompt; never let note content carry
tool-call authority) as part of this work, and a test that a private note never
appears in another member's AI context.

**Depends on / blocked by:** Builds on the shipped `noteVisibilityFilter`. The
MCP tool name/schema is a public contract (see CLAUDE.md) — changes here must be
output-additive only, never a rename.

**Effort:** M. **Priority:** P2. **Owner:** Sandy.

---

## Transcript-aware chat context-size warning + user cap

**What:** Make the chat context-size banner account for the *full* context a
turn will send, and let the user cap/trim it when it gets expensive. Today
`ChatContextSizeBanner` only sums attached **companies'** flagged-file context
via `CHAT_CONTEXT_SIZE_PREFLIGHT_MULTI`; it ignores the anchor meeting's
transcript (sent uncapped) and contacts entirely. Add: (1) the anchor meeting's
transcript chars to the estimate, (2) an "expensive context" threshold warning,
and (3) a user-facing hard cap/trim control on what's sent per message.

**Why:** With the new meeting-aware chat (PR `feat/meeting-chat-context`), a long
meeting transcript (uncapped) plus an attached company can produce a very large,
costly per-message context with no visibility or control. The user asked to be
warned and able to cap it. Each component is individually bounded today, but the
*combined* size is neither surfaced nor capped.

**Context:** This is a cross-surface feature, not specific to meeting-detail
chat — company/contact/global chats want the same warning+cap. Start points:
- `src/renderer/components/chat-panel/ChatContextSizeBanner.tsx` — currently
  renders only when `flaggedFileCount > 0`; generalize to a total-chars estimate
  with a threshold style + a "trim/cap" action.
- `CHAT_CONTEXT_SIZE_PREFLIGHT_MULTI` handler in `src/main/ipc/chat.ipc.ts` +
  `estimateChatContext` in `@cyggie/services/llm/context-size` — extend to accept
  an optional anchor `meetingId` and include its transcript chars.
- `ChatContextSizeEstimate` type in `src/shared/types/company.ts` — add the
  transcript/total breakdown fields.
- The cap mechanism is new design: a per-session max-chars the assembler honors
  (queryMeeting / buildUnifiedEntitiesContext already have per-section caps to
  build on; see `OUTER_TOTAL_CAP` in entities-chat.ts).

**Effort:** M. **Priority:** P2. **Owner:** Sandy.

**Depends on / blocked by:** The meeting-chat `refs` plumbing shipped in
`feat/meeting-chat-context` (meeting chats can now carry attached companies, which
is what makes a combined estimate meaningful).

## Migrate remaining mobile app bars to `<ScreenHeader>`

**What:** Move the still-hand-rolled app bars on the mobile screens that the
record-tab PR did not touch — settings, search, meeting detail, and the
per-entity chat screen (`app/chat/[contextKind]/[contextId].tsx`) — onto the
shared `mobile/components/ScreenHeader.tsx` component.

**Why:** The record-tab PR (`feat/mobile-record-tab`) introduced `ScreenHeader`
and migrated the 5 tab screens + global chat onto it, but the remaining screens
still duplicate the old `appbar` / `appbarTitleWrap` / `appbarTitle` /
`appbarSubtitle` style vocabulary inline. Consolidating them makes the next
header change a single-file edit and keeps the chat-button / back-chevron
affordances consistent app-wide.

**Context:** `ScreenHeader` already supports `title`, `subtitle`, `onBack`,
`actions`, `showChatButton`, and `borderBottom`, plus a `HeaderIconButton`
helper for round action buttons — see how `app/chat/index.tsx` and the tab
screens use them. Each remaining screen just needs its `<View style={appbar}>`
block swapped for `<ScreenHeader .../>` and its now-dead local appbar styles
removed. Watch for screens that want a back chevron (detail/search) vs. the
chat button (top-level surfaces).

**Effort:** M. **Priority:** P3. **Owner:** Sandy.

**Depends on / blocked by:** The `feat/mobile-record-tab` PR landing (ships
`ScreenHeader`).

---

## Offline company/attendee tagging on the meeting view

**What:** Let the user tag companies + attendees on a meeting while offline
(e.g. on a flight), the way notes already work offline. Today, when the
meeting row isn't confirmed on the gateway, the meeting view disables the
company/attendee **+** buttons and shows "Connect to tag companies and
attendees." Notes, by contrast, buffer locally and sync later.

**Why:** Notes + tagging are the two things a user does during a meeting. We
shipped offline notes (the common case) but left tagging online-only to keep
the first PR's blast radius small. Full offline parity removes a sharp edge —
"why can I type notes on the plane but not tag the company I'm meeting?"

**Pros:** Complete offline meeting capture; one consistent mental model.
**Cons:** Adds new sync-outbox op types (company-link, attendee-update) with a
**create-before-link ordering** requirement, in the exact agent path that
caused the recent sync-divergence repairs (`7f77b38`, `823a0e3`, `f524254`).
Needs its own careful, well-tested pass.

**Context:** Building blocks already exist from the in-meeting-recording PR:
- `mobile/lib/recording/confirmed-meetings.ts` — the confirmed-row gate. Reuse
  it so link/attendee ops also defer until the row exists.
- `mobile/lib/sync/outbox.ts` — today the op union is just
  `'meeting.notes.update'`. Generalize `OutboxOp` + `OutboxPayload` to a
  discriminated union and extend the agent's `processEntry`
  (`mobile/lib/sync/agent.ts`) with link/unlink/attendee handlers (the agent
  currently DLQs any unknown op).
- Gateway endpoints already exist: `POST/DELETE /meetings/:id/companies`,
  `PATCH /meetings/:id` (attendees). The mobile API wrappers are in
  `mobile/lib/api/meetings.ts`.
- Meeting view gate: `mobile/app/meetings/[id].tsx` `OverviewSection` —
  `taggingDisabled = busy || !serverConfirmed`. Drop the `!serverConfirmed`
  half once edits queue offline.
- Ordering: the outbox drains FIFO; ensure a queued link never drains before
  the meeting.create/confirm. Test the create→link→drain order explicitly.

**Effort:** M. **Priority:** P2.

**Depends on / blocked by:** The in-meeting-recording PR landing (ships the
confirmed-row gate + optimistic meeting). No gateway changes needed (endpoints
exist).

---

## Rate-limit `POST /meetings/impromptu`

**What:** Add a simple per-user rate cap on the impromptu pre-create endpoint
(`api-gateway/src/routes/meetings.ts`). Today it inserts a meetings row per
call with no quota/rate gate (unlike `/recordings/upload`, which has the
monthly-minutes quota check).

**Why:** A misbehaving or malicious client could spam empty `status='recording'`
rows. Low risk during the single-firm beta — and the 12h no-audio sweeper
(`api-gateway/src/recording/stale-sweeper.ts`, `sweepNoAudioRecordingsOnce`)
reaps abandoned ones — but it's an unbounded write surface that should be
capped before onboarding a second firm.

**Pros:** Closes an unbounded-insert surface. **Cons:** Needs a rate-limit
mechanism (per-user token bucket / sliding window); none exists in the gateway
yet, so it's net-new infra (or a lightweight `created_at`-count guard).

**Context:** The endpoint is idempotent on a client-supplied id, so a natural
cheap guard is "N distinct impromptu rows created in the last hour per user."
Pre-created rows carry no `durationSeconds`, so they don't corrupt the existing
recording quota math — this is purely abuse protection.

**Effort:** S. **Priority:** P3.

**Depends on / blocked by:** Nothing hard; revisit before second-firm
onboarding (see the single-firm-beta constraint in
`project_provider_key_architecture` memory).


## Schema-driven table column registry (contacts + companies)

**What:** Derive table column defs (key / display type / repo SELECT column /
row-map field) for the contacts and companies tables from a single
schema-backed registry, instead of hand-listing each field in ~4 places.

**Why:** Adding a contact/company field as a table column today requires edits
in four spots — the `ContactSummary`/`CompanySummary` type, the repo `SELECT`
list, `rowToContactSummary`, and the `COLUMN_DEFS` array. They drift easily:
that drift is exactly what produced the "city/state missing from the contacts
column picker" bug this TODO follows. A registry would make every DB (and
custom) field auto-available with no per-field plumbing.

**Pros:** Eliminates the drift class; "any field that exists as a column" becomes
true by construction. **Cons:** Sizable cross-cutting refactor; must map
`PropertyRowType` → `ColumnDef['type']` and render JSON/multi-value fields
generically (the current fix special-cases them as read-only computed columns).

**Context:** Start from `CONTACT_HARDCODED_FIELDS` / `CONTACT_FIELD_META`
(`src/renderer/constants/`) which already enumerate the user-facing field set and
editor types — that's the natural registry seed. The contacts table fix in
`contactColumns.ts` / `contact.repo.ts` is the reference for the manual pattern
being replaced.

**Effort:** L. **Priority:** P3.

**Depends on / blocked by:** Nothing hard; do it when a third+ batch of fields
needs surfacing.


## Reconcile talentPipeline enum vs. UI labels

**What:** Align the talent-pipeline stage values across the DB enum (migration
068: `identified, exploring, ideating, parked, internal_candidate`) and the UI
option list `TALENT_PIPELINE_OPTIONS` (`src/renderer/constants/contactFields.ts`,
which uses `fundraising` / `portfolio_candidate` and short labels).

**Why:** The DB CHECK constraint and the UI options don't fully match
(`parked` exists in the enum but no UI option; `fundraising`/`portfolio_candidate`
exist in the UI but not the enum). Mismatched values can cause filter/group
misses and confusing labels, and a write of a UI-only value could violate the
CHECK constraint.

**Pros:** Removes a latent data-integrity foot-gun. **Cons:** Needs a data audit
of existing `talent_pipeline` values before changing the enum or the options, to
avoid orphaning rows.

**Context:** Surfaced during the contacts-table column work, when
`TALENT_PIPELINE_OPTIONS` was consolidated from two divergent inline copies
(`ContactPropertiesPanel.tsx`, `Contacts.tsx`). The consolidation fixed label
drift but did NOT touch the enum-vs-options value mismatch.

**Effort:** S. **Priority:** P3.

**Depends on / blocked by:** A read-only audit of distinct `talent_pipeline`
values in production SQLite/Neon.

---

## Editable "Location" column with City/State parsing

**What:** Make the read-only computed `Location` column (city + state) in the
company and contact tables editable, parsing a typed `"City, State"` string back
into the separate `city` and `state` fields. Implement once via a new optional
`saveComputedValue` hook in `createCellCallbacks`
(`src/renderer/components/crm/tableUtils.ts`) so both `CompanyTable` and
`ContactTable` benefit; each table supplies the parse → two-field write
(`COMPANY_UPDATE` / `CONTACT_UPDATE` patch + `onPatch`).

**Why:** Users currently set location via the separate `City` and `State`
columns. A single editable `Location` cell would be a faster one-shot entry.

**Context:** Deferred deliberately during the 2026-06-16 location work. The blocker
is a silent data-loss path: the cell displays `"City, State"`, so a user editing it
who types just a city (no comma) would, under naive split-and-write-both, wipe the
existing state. A safe design (e.g. "no comma → set city, keep state; empty → clear
both") must be chosen before building. The `location` column defs already exist with
a `sortAccessor` in `companyColumns.ts` / `contactColumns.ts` (both `editable: false`,
`type: 'computed'`); `createCellCallbacks.saveCellValue` currently no-ops when
`!col.field`. Revisit only if the City + State columns prove clunky in practice.

**Effort:** S. **Priority:** P3.

**Depends on / blocked by:** Product decision on the no-comma / empty parse
semantics (the data-loss guard).

---

## Spreadsheet selection — Phase 2 (fill-handle, grid-paste, Cmd+A, header-select)

**What:** Extend the multi-cell selection (Phase 1 shipped: Cmd+click non-contiguous,
shift rectangles, TSV copy, delete-all, paste-all, bulk-fill-on-commit) toward full
Google-Sheets parity:
- **Fill-handle**: drag the active cell's corner handle to extend + fill a range.
- **TSV block-paste mapping**: paste an M×N clipboard grid mapped from the active
  cell, writing cell-by-cell with per-column type validation (today paste writes one
  value to all selected cells — "paste-all").
- **Cmd+A**: select the whole focused column (then expand to all).
- **Column-header click**: select the entire column.
- **Delight**: a selection-stats chip (count · Σ · avg for numeric columns) and
  Esc-to-collapse (collapse a multi-selection to the active cell before full clear).

**Why:** Phase 1 covers the 80% (bulk edit/copy/clear across arbitrary cells). These
are the power-user gestures that make the table feel fully spreadsheet-grade.

**Context:** Built on the Phase 1 foundation in `useEditCellNav.ts` (the hybrid
`CellSelection` = `rects[] + added/removed + anchor/active`, `getCellEdges`,
`effectiveCells`) and `useCellClipboard.ts` (the shared `writeAndRegister` helper +
`fillSelection`). Fill-handle needs a new pointer-drag state machine in the tables;
block-paste needs a TSV *parser* (Phase 1 only has the TSV *serializer*, `buildTsv`)
plus per-cell validation/partial-failure reporting (the `writeAndRegister` pattern
already reports partials). Cmd+A / header-select are new gestures dispatched into
`handleFocusCell`-style setters. The CEO review explicitly deferred these as the
"risky 20%" to keep Phase 1 shippable.

**Effort:** L. **Priority:** P3.

**Depends on / blocked by:** Phase 1 (shipped). Fill-handle + block-paste each
warrant their own focused PR + tests.

## Keyset/cursor pagination for `GET /companies`

**What:** Replace the mobile Companies list's offset pagination with a
`(last_touch_at, created_at, id)` keyset cursor.

**Why:** Offset paging can skip or duplicate a row if companies/meetings change
while the user is mid-scroll (the sort key shifts under the offset window). The
current ship mitigates this with an `id`-DESC tie-break (deterministic order over a
stable dataset) but is not write-concurrency-safe.

**Context:** Shipped in the "recently-added companies don't show on mobile" fix —
the Companies tab now infinite-scrolls via `useCompaniesInfiniteQuery` over
offset/limit, with the gateway sorting `last_touch_at DESC NULLS LAST, created_at
DESC, id DESC`. Keyset would carry the last row's `(last_touch_at, created_at, id)`
forward as a cursor instead of an integer offset. Start at the `GET /companies`
handler in `api-gateway/src/routes/companies.ts` (add cursor WHERE + keep the same
ORDER BY) and `companiesNextPageParam` / `useCompaniesInfiniteQuery` in
`mobile/lib/api/companies.ts`.

**Effort:** M. **Priority:** P3.

**Depends on / blocked by:** None. **Trigger:** a firm large enough that
scroll-during-edit produces visible skips/dupes.

---

## Sync — whole-row-LWW local `lamport='0'` flicker window

**What:** After a local write to any whole-row-LWW owned table (notes, meetings,
chat_sessions, investment_memos, custom fields, flagged files…), the SQLite row keeps
`lamport='0'` until the first pull-back echo heals it (`upsertNoteRow` et al. write
`lamport = excluded.lamport`). `withSync` only stamps the local row's lamport for
*fieldLww* tables (`stampFieldLww` in
[packages/db/src/sqlite/repositories/_sync.ts](packages/db/src/sqlite/repositories/_sync.ts));
whole-row LWW does not.

**Why:** During the brief push→echo window, a concurrent echo of an earlier version can
transiently win the lamport compare in `applyRemoteRows`
([src/main/services/sync-remote-apply.ts](src/main/services/sync-remote-apply.ts)) and
cause a momentary UI flicker (old content shown, then re-corrected). It **self-heals** —
the echo writes the real lamport, and later edits always carry a strictly higher lamport,
so state converges; there is **no permanent data loss**. The dangerous blank-corruption
case is already guarded by `reconcileBlankNote` (`preGateReconcile`).

**Fix:** Stamp the local row's `lamport` (= the txn lamport) for whole-row-LWW inserts/
updates inside `withSync`, analogous to `stampFieldLww` but without the field map. Start in
`_sync.ts` (the post-`fn` emit block, the `else` of `isFieldLwwWrite`).

**Pros:** Removes the flicker everywhere; makes the local `lamport` column trustworthy for
future tooling. **Cons:** Touches `withSync`'s core path for **every** whole-row-LWW owned
table → needs a full re-test of all of them, for a symptom that self-heals. Surfaced during
the `fix/company-notes-draft-and-sync` review; deliberately deferred there (parity-only fix).

**Depends on / blocked by:** None.
