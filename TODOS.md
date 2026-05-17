# TODOS

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
