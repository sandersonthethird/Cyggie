# TODOS

## P3 — Companies

### Memo version history UI
**What:** Make the version chip (`v2`, `v3`…) in `CompanyMemo` interactive — clicking it opens a panel or dropdown listing all past `InvestmentMemoVersion` rows, with a "Restore" button per entry.
**Why:** The version counter is already displayed but non-interactive. With auto-save creating a new version on every edit session, users have no way to browse or recover an earlier draft if they want to revert a generation run or a bad edit.
**Pros:** Completes the versioning story end-to-end; pairs naturally with the AI generation flow where you want to compare the AI draft against a previous version.
**Cons:** Requires a new `INVESTMENT_MEMO_LIST_VERSIONS` IPC + repo query; the restore action is a write (saves a new version with old content) to avoid mutating history.
**Context:** Start in `src/renderer/components/company/CompanyMemo.tsx`. The version chip is already rendered at line ~71 (`<span className={styles.version}>v{memo.latestVersionNumber}</span>`). Make it a `<button>` that opens a `MemoVersionHistoryPanel` (or inline dropdown). List versions via `INVESTMENT_MEMO_LIST_VERSIONS`; restore by calling `INVESTMENT_MEMO_SAVE_VERSION` with the old version's `contentMarkdown`. The `CompanyMemo` `handleSaved` callback already handles updating read view state.
**Effort:** L
**Priority:** P3
**Depends on:** Memo edit modal PR (this work) merged.

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

### Tests for frontmatter utilities
**What:** Unit tests for `parseFrontmatter()` and `parseAppleNotesDate()` in `src/main/utils/frontmatter.ts`.
**Why:** Both functions fail silently (return null on bad input). The date format — "Friday, October 30, 2020 at 7:25:21 PM" — is non-standard and locale-sensitive. If a user's Apple Notes export uses a different locale or format variant, dates silently stay at import time with no indication anything went wrong.
**Pros:** Pure functions — ideal for fast unit tests; ~8 cases cover the full input space.
**Cons:** Minimal effort given existing test infra in src/tests/.
**Context:** Added in the frontmatter repair PR (migration-065). Start in `src/tests/frontmatter.test.ts`. Cover: valid full parse, missing `modified` field, malformed closing `---`, unparseable date string, already-stripped content (no frontmatter).
**Effort:** S
**Priority:** P3
**Depends on:** frontmatter repair PR merged.

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

### BubbleMenu shared component
**What:** Extract the Tiptap BubbleMenu JSX (Bold/Italic/H1/H2/H3/List buttons) into a shared `<TiptapBubbleMenu editor={editor} />` component used by `NotePaneEditor`, `MeetingDetail`, and any future Tiptap surfaces.
**Why:** After the Meeting Detail redesign, 2 files have near-identical BubbleMenu JSX. A 3rd consumer would make extraction clearly worthwhile.
**Pros:** Single place to add/remove toolbar buttons (e.g., adding code block, link toggle).
**Cons:** Small extra indirection; buttons may need slight variation per surface (e.g., Meeting notes may not need H3).
**Context:** `NotePaneEditor.tsx` has a 7-button BubbleMenu. `MeetingDetail.tsx` has a 5-button variant (no H3, no code). Extract to `src/renderer/components/common/TiptapBubbleMenu.tsx` with an optional `buttons` prop for customization.
**Effort:** S
**Priority:** P3
**Depends on:** Meeting Detail redesign PR (creates the 2nd consumer — completed).

---

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
**What:** Establish React Testing Library tests for `NewCompanyModal`, covering the `addToPartnerSync` checkbox logic as the first set of cases.
**Why:** The checkbox boolean gate (4 codepaths: deck/manual × checked/unchecked) has zero automated coverage. The most dangerous regression is the checkbox being unchecked but IPC calls still firing.
**Pros:** RTL + vitest is straightforward with mocked `api.invoke`; once set up, all future component work in the project is testable.
**Cons:** RTL infrastructure doesn't exist yet — ~1-2h overhead to add `@testing-library/react` + `@testing-library/user-event` alongside the existing vitest setup.
**Context:** No React Testing Library in the project yet. The test should mock `api.invoke` at the module level and assert: (1) unchecked → neither `PARTNER_MEETING_ADD_PITCH_DECK_COMPANY` nor `PARTNER_MEETING_GET_ACTIVE` called; (2) checked + `extractedResult` → `PARTNER_MEETING_ADD_PITCH_DECK_COMPANY` called; (3) checked + no `extractedResult` → `PARTNER_MEETING_GET_ACTIVE` then `PARTNER_MEETING_ITEM_ADD` called; (4) modal reopen → checkbox resets to checked. See `src/tests/useNoteEditor.test.ts` for the existing vitest config pattern.
**Effort:** M
**Priority:** P3
**Depends on:** This PR merged (checkbox must exist to test).

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

### Tests for runPitchDeckAnalysis vision path
**What:** Unit tests for the new vision re-read branch in `runPitchDeckAnalysis`.
**Why:** Three new branches have zero coverage: (1) sourceFilePath re-read → LLM with attachment, (2) both rawText + sourceFilePath absent → null, (3) readFileSync throws → null. The fix being shipped is code-only; logging alone won't catch regressions.
**Pros:** Simple unit tests; establishes test pattern for IPC handler utilities.
**Cons:** `runPitchDeckAnalysis` is not currently exported — would need extraction to a utility or explicit export.
**Context:** Function lives in `src/main/ipc/partner-meeting.ipc.ts`. Export it and add 3 test cases in `src/tests/pitch-deck-analysis.test.ts`. Mock `getProvider`, `readFileSync`, and `extractPartnerSyncBrief`. Pattern: see `src/tests/useNoteEditor.test.ts` for vitest config.
**Effort:** S
**Priority:** P3
**Depends on:** This PR (vision path fix) merged.

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

## P3 — Custom Fields

### URL param persistence for custom field select filters
**What:** Custom field select filters reset on navigation because `field: null` in `buildCustomFieldColumnDefs` prevents `useTableFilters` from encoding them into URL params.
**Why:** Users who filter on a custom "Focus" column (e.g. "B2B") lose the filter when they click into a company detail and navigate back.
**Effort:** M
**Context:** `useTableFilters` guards on `if (!col.field) continue` before writing URL params. `applySelectFilter` operates on `row[field]`, so if `field: def.fieldKey`, pass-1 filtering silently zeros the result set for custom columns. Fix requires: (1) use `col.key` (not `col.field`) as the URL param key for custom columns, (2) split `selectFilters` dict into built-in vs. custom before calling `applySelectFilter` in pass 1. Start in `useTableFilters.ts` (lines ~75-98) and `filterCompanies`/`filterContacts` in `Companies.tsx`/`Contacts.tsx`.
**Depends on:** Custom field columns in table (this PR).

---

## P2 — CRM Tables

### FilterChips shared component
**What:** Extract filter chip rendering JSX from `Companies.tsx` and `Contacts.tsx` into a shared `<FilterChips>` component.
**Why:** ~70 lines of near-identical JSX in each route file (select chips, range chips, text chips, clear-all button). Currently duplicated because CSS modules are per-route.
**Effort:** S
**Context:** Both routes use `useTableFilters` and have the same chip rendering pattern. Create `src/renderer/components/crm/FilterChips.tsx` + `FilterChips.module.css`. Move chip styles out of `Companies.module.css` and `Contacts.module.css` into the shared CSS module. Props: `{ columnFilters, rangeFilters, textFilters, columnDefs, onColumnFilter, onRangeFilter, onTextFilter, clearAllFilters }` — all available from the `useTableFilters` hook return value.
**Depends on:** `useTableFilters` hook (already landed).

---

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

### Determinate progress bar during email discovery
**What:** Show a progress bar (not just text) once the total message count is known.
**Why:** The current "Fetching 42 of 312…" text is helpful but a visual progress bar would make long syncs much less anxiety-inducing.
**Effort:** S
**Context:** The `COMPANY_EMAIL_INGEST_PROGRESS` and `CONTACT_EMAIL_INGEST_PROGRESS` channels already emit `{ phase, fetched, total }`. The `total` is known after the discovering phase completes. Add a `<progress>` element or a CSS-based bar to the sync row in `CompanyTimeline.tsx` and `ContactEmails.tsx`.

---

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

### Reset layout action
**What:** Single "Reset to defaults" action that clears `fieldPlacements`, `addedFields`, and `sectionOrder` prefs for the current entity type.
**Why:** After extensive layout customization, users may want a clean slate without manually undoing each change.
**Pros:** Escape hatch for a confused layout state; very low implementation cost.
**Cons:** No undo — user loses all customizations. Could add a confirmation dialog.
**Context:** A `— Reset layout →` link in the `AddFieldDropdown` footer (or a button in Settings). Implementation: call `setJSON(addedFieldsKey, [])`, `setJSON(placementsKey, {})`, `setJSON(sectionOrderKey, [])` in `usePreferencesStore`. Each write triggers React re-render; panel snaps back to defaults immediately. ~15 min to implement. Start in `AddFieldDropdown.tsx` footer and `useFieldVisibility.ts` (add `resetLayout()` to returned interface).
**Effort:** S
**Priority:** P3
**Depends on:** Detail panel UX overhaul PR (AddFieldDropdown, useFieldVisibility, useSectionOrder).

---

## P3 — Header Panel UX

### Bulk "Add all section to header" button
**What:** A per-section `↑ All` link in edit mode that adds all fields in that section to the header chips in one click.
**Why:** If a user has 5+ fields in a section and wants to surface all of them as chips, clicking the × drag for each is tedious. A bulk action removes friction.
**Pros:** Zero-friction for power users building info-dense headers; consistent with the drag-to-header paradigm already in place.
**Cons:** Could create visual clutter if users accidentally bulk-add many chips. Requires a "dedup-safe" bulk togglePinnedKey call.
**Context:** The drag-to-header system (Change 1) is complete: dragging a field to the Header section auto-adds it to `cyggie:contact-summary-fields` / `cyggie:company-summary-fields` via `computeChipDelta`. A bulk add would call `togglePinnedKey(chipId, true)` for each field in the section that isn't already in `pinnedKeys`. The `+ All` button would appear next to the `+ Add field` button in each section in edit mode (only visible when the section has fields not yet in the header). Start in `ContactPropertiesPanel.tsx` and `CompanyPropertiesPanel.tsx` in the `renderSectionedFields` callers.
**Effort:** S
**Depends on:** Header section unification PR (drag-to-header, Change 1).


---

## P2 — Tests

### Unit tests for provider-factory + OpenAIProvider
**What:** Tests for `getProvider()` routing (6 combinations: provider × use) and `OpenAIProvider` (key missing, streaming, abort, empty response).
**Why:** The factory is the single point of failure for all LLM features. If routing is broken, every summarization, chat, and enrichment call silently fails or uses the wrong model.
**Pros:** Catches regressions if new providers are added; documents expected routing behavior.
**Cons:** Requires mocking `openai` and `@anthropic-ai/sdk` SDKs.
**Context:** Factory at `src/main/llm/provider-factory.ts`. Provider at `src/main/llm/openai-provider.ts`. Mock both SDKs at module level; assert `new OpenAIProvider(key, model)` / `new ClaudeProvider(key, model)` / `new OllamaProvider(model, host)` are returned for each (`llmProvider` × `use`) combination. Test error thrown when key missing for claude/openai.
**Effort:** S
**Depends on:** OpenAI provider + factory (shipped in this change)


---

## P2 — Notes Import

### Filter Notes by import source (filter pill UI)
**What:** Add a dedicated filter pill in the Notes view to show only notes imported from a specific source (Apple Notes, Notion, generic).
**Why:** After importing hundreds of notes, users need a way to find them quickly — especially to review or clean up the import. Without a source filter, imported notes are mixed invisibly into the full notes list.
**Pros:** Makes import verifiable and actionable; enables "find all imported from Notion" workflows.
**Cons:** Low complexity — the hard parts (schema, type, IPC) are already done. Remaining work is a UI filter pill only.
**Context:** Schema is complete: `import_source TEXT` column exists (migration 057), `Note` type exposes `importSource`, `createNote` writes it. The `FolderSidebar` already renders import sources as chips (visible when import sources exist). The remaining work is: expose this as a filter option in the filter pill row in Notes.tsx (or integrate into the sidebar chips more prominently). ~1 hour of UI work.
**Effort:** S
**Depends on:** Nothing — schema and backend are already in place.


---

## P2 — Notes

### Use meeting title as note card title fallback
**What:** When a note has no explicit `title` but has a `sourceMeetingId`, display the linked meeting's title as the note card title in the Notes list.
**Why:** Meeting-sourced notes created without a typed title currently fall back to the first line of content (which may be blank or a heading), making them hard to identify in the list.
**Pros:** Makes meeting-sourced notes clearly identifiable by their meeting name without any user action.
**Cons:** Requires a JOIN to the `meetings` table in `listNotes()`, or adding a denormalized `meeting_title` column to `notes` (migration needed). The JOIN approach is simpler but adds query cost.
**Context:** `listNotes()` is in `src/main/database/repositories/notes.repo.ts`. The `firstLine` extraction in `src/renderer/routes/Notes.tsx` (~line 541) already has a fallback chain — adding `note.meetingTitle` as the second priority (after `note.title`, before content extraction) is the right insertion point. The JOIN would add `m.title AS meeting_title` to the existing LEFT JOINs in the base SELECT.
**Effort:** S
**Depends on:** None

### Enable `onCreate` in Notes.tsx bulk-tag company picker
**What:** Pass `onCreate={handleCreateBulkCompany}` to the `EntityPicker` in the Notes.tsx bulk-tag flow so users can create a new company inline while tagging notes.
**Why:** Users bulk-tagging notes to a newly-created company currently have to navigate to the Companies view to create it first, then return to Notes to tag — two round-trips for what should be a single action.
**Pros:** Makes bulk-tagging self-contained; reuses `COMPANY_FIND_OR_CREATE` IPC and `EntityPicker.onCreate` added in the company-swap PR.
**Cons:** Minimal — async `handleCreateBulkCompany` callback mirrors `NoteTagger.handleCreateCompany` verbatim.
**Context:** Notes bulk-tag picker is in `src/renderer/routes/Notes.tsx` around the company `EntityPicker` usage. Add `handleCreateBulkCompany` async callback (`api.invoke(COMPANY_FIND_OR_CREATE, name)` → set selected company), pass as `onCreate`. Pattern is identical to `NoteTagger.tsx` — see `src/renderer/components/notes/NoteTagger.tsx:42-55` for reference.
**Effort:** S
**Depends on:** Company swap PR (`COMPANY_FIND_OR_CREATE` IPC + `EntityPicker.onCreate`)

---

## P3 — Refactoring

### Centralize parseTimestamp / SQLITE_DATETIME_RE
**What:** Extract `parseTimestamp`, `pickLatestTimestamp`, `setLatestMapValue`, and `SQLITE_DATETIME_RE` into a shared utility (e.g. `src/main/utils/db-utils.ts`) and remove the duplicates from `contact-utils.ts` and `org-company.repo.ts`.
**Why:** Two identical implementations exist — any bug fix or change would need to be applied twice.
**Pros:** Single source of truth; ~20 lines saved.
**Cons:** Another import to add to two already-large files.
**Context:** `parseTimestamp` + `SQLITE_DATETIME_RE` live in `src/main/database/repositories/contact-utils.ts` (exported) and `src/main/database/repositories/org-company.repo.ts` (local copy). Both are identical. Extraction is zero-risk — pure functions with no side effects. `setLatestMapValue` and `pickLatestTimestamp` are only in contact-utils.ts currently. Create `src/main/utils/db-utils.ts`, re-export from `contact-utils.ts` for backward compat.
**Effort:** S
**Priority:** P3
**Depends on:** contact-utils.ts extraction (this PR).

---

### Centralize parseJsonArray / parseEmailParticipants
**What:** Consolidate `parseJsonArray` and `parseEmailParticipants` into a shared utility module — they currently have slightly different implementations across `contact-utils.ts`, `meeting.repo.ts`, and `org-company.repo.ts`.
**Why:** Signature drift between copies means bug fixes in one copy don't propagate; the email participant shape is defined three times.
**Pros:** Unified parsing; easier to test once; easier to extend the participant role set.
**Cons:** Signatures differ (e.g. the meeting.repo.ts version may handle extra fields) — needs careful reconciliation to avoid behavior changes.
**Context:** `parseJsonArray` is in `contact-utils.ts` and used by multiple repos. `parseEmailParticipants` has variants in `contact-utils.ts` and likely in `meeting.repo.ts` / `org-company.repo.ts`. Audit all three before merging — reconcile the allowed `role` set and the `contactId` field presence. Put the canonical version in `src/main/utils/db-utils.ts` (alongside `parseTimestamp`).
**Effort:** S
**Priority:** P3
**Depends on:** parseTimestamp centralization above.

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

### Create error UX in NoteTagger
**What:** Show user-visible feedback when contact or company creation fails in the note tagger.
**Why:** Both `handleCreateContact` and `handleCreateCompany` in `NoteTagger.tsx` currently `console.error` only — if the IPC call throws (e.g. DB locked, empty name), the user sees nothing and the picker just closes.
**Pros:** Eliminates silent failure; user knows to retry.
**Cons:** No shared toast/notification pattern exists yet — a one-off inline error would be inconsistent with future patterns.
**Context:** Both handlers in `src/renderer/components/notes/NoteTagger.tsx` have `catch (err) { console.error(...) }` blocks. The right fix is to add an error state (`const [createError, setCreateError] = useState<string | null>(null)`) rendered below the picker input. Should follow whatever global notification/toast pattern is adopted first; otherwise an inline approach works as a stopgap.
**Effort:** S (inline approach) / M (shared notification pattern)
**Priority:** P2
**Depends on:** Global notification/toast pattern (or accept inline approach as stopgap).


---

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

### Add idx_notes_folder index
**What:** `CREATE INDEX idx_notes_folder ON notes(folder_path)` in a new migration.
**Why:** `getFolderCounts()` does a full table scan (`GROUP BY folder_path`). Fast at 1k notes, degrades at 100k+.
**Pros:** Trivial one-line migration; no behavior change; future-proofs the feature.
**Cons:** Negligible extra storage and write overhead per insert/update.
**Context:** `getFolderCounts()` is in `src/main/database/repositories/notes.repo.ts`. Add a new migration file (next after 063). The index is not needed at current scale but costs almost nothing to add.
**Effort:** S
**Priority:** P3
**Depends on:** getFolderCounts() (this PR).

---

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

### Tests for COMPANY_ANALYZE_FILE handler
**What:** Unit/integration tests for the `COMPANY_ANALYZE_FILE` IPC handler in `company.ipc.ts` — happy path (note created), LLM returns null (`analysis_failed`), and DB throws (`note_creation_failed`).
**Why:** The handler is the critical path for file-based company enhancement. A silent regression (LLM path, DB write, or error serialization) would leave users with no note created and no visible failure. The three error cases have distinct return shapes that need explicit coverage.
**Pros:** Pure handler logic — easy to test with mocked `runPitchDeckAnalysis` and `createCompanyNote`; ~6 test cases cover the full input space; no new infra needed beyond the existing `src/tests/` vitest setup.
**Cons:** Requires mocking two async functions across module boundaries.
**Context:** Handler is at the end of `registerCompanyHandlers()` in `src/main/ipc/company.ipc.ts`. Happy path: mock `runPitchDeckAnalysis` returning a string → assert `noteId` returned. LLM null path: mock returning null → assert `{ noteId: null, error: 'analysis_failed' }`. DB throw path: mock `createCompanyNote` throwing → assert `{ noteId: null, error: 'note_creation_failed' }` and that the error is logged. Start in `src/tests/company-analyze-file.test.ts`.
**Effort:** S
**Priority:** P2
**Depends on:** `COMPANY_ANALYZE_FILE` handler (this PR).

---

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
