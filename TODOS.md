# TODOS

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

## P2 — Email Sync

### Determinate progress bar during email discovery
**What:** Show a progress bar (not just text) once the total message count is known.
**Why:** The current "Fetching 42 of 312…" text is helpful but a visual progress bar would make long syncs much less anxiety-inducing.
**Effort:** S
**Context:** The `COMPANY_EMAIL_INGEST_PROGRESS` and `CONTACT_EMAIL_INGEST_PROGRESS` channels already emit `{ phase, fetched, total }`. The `total` is known after the discovering phase completes. Add a `<progress>` element or a CSS-based bar to the sync row in `CompanyTimeline.tsx` and `ContactEmails.tsx`.

