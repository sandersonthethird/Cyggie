# TODOS

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
**Why:** Regex extraction is brittle for varied summary formats; misses custom fields entirely; the two code paths now use different extraction strategies for the same data.
**Pros:** Unified code path; custom fields populated on first summary; more robust extraction.
**Cons:** LLM adds latency to summary generation (already has one LLM call; this adds another or requires combining them); harder to test without mocking.
**Context:** `getVcSummaryCompanyUpdateProposals()` is called from `summary.ipc.ts` during `SUMMARY_GENERATE`. It feeds `companyUpdateProposals` in `SummaryGenerateResult`. The regex path is fast and appropriate for first-meeting auto-fill (no prior data). Full migration may be premature; consider a hybrid: regex for speed, LLM only when custom fields are defined.
**Effort:** M
**Priority:** P3
**Depends on:** Company enrichment feature (this PR).

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
**Context:** Currently all three prefs are stored via `usePreferencesStore` which reads/writes localStorage (`cyggie:contact-added-fields`, `cyggie:contact-field-placements`, `cyggie:contact-sections-order`, and company equivalents). Migration path: new `user_layout_prefs(entity_type TEXT, pref_key TEXT, value_json TEXT, updated_at TEXT)` table. New IPC `PREFS_GET`/`PREFS_SET`. `usePreferencesStore` hydrates from DB on startup + fire-and-forget writes. Build as its own focused PR after the detail panel UX overhaul ships; plan alongside web version work.
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

### Filter Notes by import source
**What:** Add a filter pill in the Notes view to show only notes imported from a specific source (Apple Notes, Notion, generic).
**Why:** After importing hundreds of notes, users need a way to find them quickly — especially to review or clean up the import. Without a source filter, imported notes are mixed invisibly into the full notes list.
**Pros:** Makes import verifiable and actionable; enables "find all imported from Notion" workflows.
**Cons:** Requires a schema change: `import_source TEXT` column on the `notes` table + a migration. The import handler already logs `importSource` in audit, but the notes table itself has no such column.
**Context:** Import handler (`src/main/ipc/notes.ipc.ts`) sets `importSource` in `logAudit()`. To surface this in the UI: (1) add `import_source` column to `notes` table in a migration, (2) write it in `notesRepo.createNote()` when provided, (3) expose it on the `Note` type in `src/shared/types/note.ts`, (4) add a `source` filter option to `NoteFilterView` and `listNotes()`, (5) add a filter pill in `src/renderer/routes/Notes.tsx`.
**Effort:** M
**Depends on:** Notes import feature (this change)
