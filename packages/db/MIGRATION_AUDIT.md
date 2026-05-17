# Migration Audit — SQLite → Postgres consolidation

This file tracks the porting of the 95 SQLite migrations under [src/main/database/migrations/](../../src/main/database/migrations/) into the consolidated drizzle schema in [`packages/db/src/schema/`](./src/schema/).

**Strategy:** consolidated drizzle schema (one coherent Postgres schema representing the final state after all 95 migrations) + this audit tracking which source migration introduced each table/column. This matches `web/`'s pattern and avoids replaying 95 migrations on every Neon deploy.

**Per-row template:**

```
migration_number | sqlite_purpose | drizzle_file | type_translations | indexes_ported | fks_ported | fts_strategy | test_status
```

Status legend: `🟢 done` · `🟡 in progress` · `⚪ pending` · `🔁 repair-script` (re-classify as data-quality script, run post-data-migration)

**Type translations applied throughout:**
- SQLite `INTEGER` timestamps → `timestamp with time zone`
- SQLite `TEXT` ISO timestamps → `timestamp with time zone`
- SQLite `0/1` booleans → real `boolean`
- SQLite JSON-in-TEXT → `jsonb`
- SQLite `INTEGER` PK auto-increment → `serial` or `bigserial`
- SQLite FTS5 virtual tables → `tsvector` columns + GIN indexes (rewrite required for `search.repo.ts`)
- SQLite text-pattern collation → Postgres `text_pattern_ops` operator class where needed

**Multi-tenant scaffolding applied throughout:** every owned table gains `user_id` FK to `users(id)` + Postgres row-level security policy.

**Sync metadata applied throughout:** every owned table gains a `_lamport` column (text, defaults '0'). The `writeWithSync` repo helper bumps it + writes to `outbox` atomically.

---

## Gateway-new tables (Phase 0.2 baseline 🟢 done)

| Table | File | Drizzle migration |
|---|---|---|
| `users` | [auth.ts](./src/schema/auth.ts) | 0000_shiny_aqueduct |
| `sessions` | [auth.ts](./src/schema/auth.ts) | 0000_shiny_aqueduct |
| `oauth_tokens` | [auth.ts](./src/schema/auth.ts) | 0000_shiny_aqueduct |
| `outbox` | [sync.ts](./src/schema/sync.ts) | 0000_shiny_aqueduct |
| `sync_state` | [sync.ts](./src/schema/sync.ts) | 0000_shiny_aqueduct |
| `migration_progress` | [sync.ts](./src/schema/sync.ts) | 0000_shiny_aqueduct |
| `audit_log` | [audit.ts](./src/schema/audit.ts) | 0000_shiny_aqueduct |

## Domain tables landed (Phase 0.2 in progress)

| Drizzle migration | Tables | Source migrations consolidated |
|---|---|---|
| 0001_kind_stingray | `meetings`, `meeting_speakers`, `speakers`, `meeting_speaker_contact_links`, `meeting_company_links`, `transcript_summaries`, `templates` | 001, 003, 004, 005, 006, 011, 034, 042, 055, 064, 071, 089 (and partial 025) |
| 0002_silent_rockslide | `contacts`, `contact_emails`, `contact_decision_logs` (+ wires meeting_speaker_contact_links → contacts FK) | 022, 023, 027, 036, 038, 041, 048, 051, 066, 068, 069 |
| 0003_shocking_skreet | `org_companies`, `org_company_aliases`, `org_company_contacts`, `company_investors`, `company_decision_logs`, `company_flagged_files` (+ wires contacts.primary_company_id, meeting_company_links.company_id FKs) | 008, 012, 013, 014, 020, 028, 035, 037, 044, 045, 050, 056, 070, 072, 073, 075, 076, 083 |
| 0004_ancient_steve_rogers | `notes`, `note_folders` (+ GIN tsvector index for FTS) | 052, 054, 057, 058, 082 |
| 0005_sturdy_photon | `themes`, `tasks`, `chat_sessions`, `chat_session_messages` (+ GIN FTS + V1 citations), `pipeline_configs`, `pipeline_stages`, `custom_field_definitions`, `custom_field_values`, `settings`, `user_preferences`, `partner_meeting_digests`, `partner_meeting_items`, `deals`, `investment_memos`, `investment_memo_versions`, `memo_evidence`, `agent_runs`, `agent_run_events`, `stress_test_reports` (+ notes.theme_id FK) | 017, 018, 026, 029, 031, 039, 040, 043, 049, 059, 061, 078, 085, 086, 087, 090, 091, 092, 093, 094, 095 |

**Source migrations covered (schema):** 001, 003, 004, 005, 006, 008, 011, 012, 013, 014, 017, 018, 020, 022, 023, 025 (partial), 026, 027, 028, 029, 031, 034, 035, 036, 037, 038, 039, 040, 041, 042, 043, 044, 045, 048, 049, 050, 051, 052, 054, 055, 056, 057, 058, 059, 061, 064, 066, 068, 069, 070, 071, 072, 073, 075, 076, 078, 082, 083, 085, 086, 087, 089, 090, 091, 092, 093, 094, 095 — **69 of 95 (all non-repair, non-superseded migrations)** ✅

**Source migrations handled inline during port (not separate drizzle migrations):**
- 002 (FTS5 virtual tables) → replaced by GIN tsvector expression indexes on notes + chat_session_messages
- 030 (performance indexes) → indexes added directly to each table during port
- 064 (calendar dedup) → partial UNIQUE index baked into `meetings_calendar_event_idx`

**Source migrations marked "skip — superseded" (no port needed):**
- 007 (legacy chat_messages on meetings) — superseded by chat_sessions in 078
- 015 (legacy company_os_chat) — superseded by chat_sessions in 078
- 016 (legacy company_notes) — superseded by unified notes in 052
- 032 (user_profile_fields) — subsumed by gateway `users` table
- 033 (user_name_parts) — subsumed by `users.display_name`
- 063 (remove notification_contacts) — table never carries forward
- 079 (drop company_conversations) — already-dropped table
- 081 (drop legacy notes tables) — already-dropped tables

**Source migrations deferred to Phase 0.3 (data-migration repair scripts, `🔁`):**
- 009, 010 (companies_cache + clear — cache layer, may not carry forward)
- 019 (CompanyOS backfill)
- 021 (domain normalization)
- 024 (data integrity)
- 046 (builtin field defs — seed)
- 047 (backfill normalized names)
- 053 (convert manual notes)
- 060 (repair own company contacts)
- 062 (repair owner linkedin url)
- 065 (repair imported note frontmatter)
- 067 (repair company view flag)
- 074 (backfill company domains)
- 077 (industry consolidation)
- 080 (backfill meeting chats)
- 084 (repair bad primary domains)
- 088 (portfolio stage backfill)

**Phase 0.2 schema port is functionally complete.** Remaining work (Phase 0.3) lives in the data-migration tool: 16 repair scripts run post-data-migration against the populated Postgres data.

---

## Source migrations (95)

### Migrations 001–010 — Foundation

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 001 | `001-initial-schema` (meetings, templates, settings, speakers, meeting_speakers) | Port verbatim | `meetings.ts`, `templates.ts`, `settings.ts` | ⚪ pending |
| 002 | `002-fts5-tables` (FTS5 virtual tables for meetings/transcripts) | Rewrite as tsvector + GIN on source columns | `meetings.ts` | ⚪ pending |
| 003 | `003-notes-column` (notes column on meetings) | Column add | `meetings.ts` | ⚪ pending |
| 004 | `004-transcript-segments` (transcript_segments table) | Port verbatim | `meetings.ts` | ⚪ pending |
| 005 | `005-drive-columns` (Google Drive integration columns) | Column add | `meetings.ts` | ⚪ pending |
| 006 | `006-attendees-column` (attendees JSON on meetings) | Column add, jsonb | `meetings.ts` | ⚪ pending |
| 007 | `007-chat-messages` (legacy chat_messages — superseded by 078) | Skip — 078 replaces | — | ⚪ pending |
| 008 | `008-companies` (initial companies table — pre-CompanyOS) | Skip — 012 replaces | — | ⚪ pending |
| 009 | `009-companies-cache` (companies_cache table) | Port if still used; verify | `companies.ts` | ⚪ pending |
| 010 | `010-clear-company-cache` | 🔁 repair-script | data-migration | ⚪ pending |

### Migrations 011–020 — CompanyOS core

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 011 | `011-recording-path` (recording_path on meetings) | Column add | `meetings.ts` | ⚪ pending |
| 012 | `012-company-os-core` (org_companies + canonical company model) | Port verbatim | `companies.ts` | ⚪ pending |
| 013 | `013-company-os-email` (company email + domain) | Column add | `companies.ts` | ⚪ pending |
| 014 | `014-company-os-artifacts` (company artifacts) | Port verbatim | `companies.ts` | ⚪ pending |
| 015 | `015-company-os-chat` (legacy company chat — superseded by 078) | Skip — 078 replaces | — | ⚪ pending |
| 016 | `016-company-os-notes` (legacy company_notes — superseded by 052) | Skip — 052 unifies | — | ⚪ pending |
| 017 | `017-company-os-memo` (investment memos) | Port verbatim | `memos.ts` | ⚪ pending |
| 018 | `018-company-os-thesis` (firm thesis) | Port verbatim | `companies.ts` or `thesis.ts` | ⚪ pending |
| 019 | `019-company-os-backfill` | 🔁 repair-script | data-migration | ⚪ pending |
| 020 | `020-company-classification` | Column add (classification enum) | `companies.ts` | ⚪ pending |

### Migrations 021–030 — Contacts + Pipeline

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 021 | `021-company-domain-normalization` | 🔁 repair-script + index | data-migration + `companies.ts` | ⚪ pending |
| 022 | `022-contact-multi-email` (contact_emails table) | Port verbatim | `contacts.ts` | ⚪ pending |
| 023 | `023-contact-name-parts` (first/last name columns) | Column add | `contacts.ts` | ⚪ pending |
| 024 | `024-data-integrity` | 🔁 repair-script | data-migration | ⚪ pending |
| 025 | `025-auth-foundation` (user_id columns on entities) | Replaced by Phase 0.2 multi-tenant scaffolding | — | ⚪ pending |
| 026 | `026-pipeline-stages` (pipeline_stages table) | Port verbatim | `pipeline.ts` | ⚪ pending |
| 027 | `027-contact-type` (contact_type enum) | Column add | `contacts.ts` | ⚪ pending |
| 028 | `028-company-location` (location columns) | Column add | `companies.ts` | ⚪ pending |
| 029 | `029-pipeline-company-fields` (pipeline columns on companies) | Column add | `companies.ts` | ⚪ pending |
| 030 | `030-performance-indexes` | Add indexes during port; verify with EXPLAIN ANALYZE | various | ⚪ pending |

### Migrations 031–040 — Tasks + User + Custom fields

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 031 | `031-tasks` (tasks table) | Port verbatim | `tasks.ts` | ⚪ pending |
| 032 | `032-user-profile-fields` | Subsumed by `users` table | — | ⚪ pending |
| 033 | `033-user-name-parts` | Subsumed by `users.display_name` | — | ⚪ pending |
| 034 | `034-template-instructions` (instructions column on templates) | Column add | `templates.ts` | ⚪ pending |
| 035 | `035-company-flagged-files` (company_flagged_files table) | Port verbatim — security-critical (referenced by capability-scoped file IPC PR2) | `companies.ts` | ⚪ pending |
| 036 | `036-contact-extra-fields` | Column add | `contacts.ts` | ⚪ pending |
| 037 | `037-company-extra-fields` | Column add | `companies.ts` | ⚪ pending |
| 038 | `038-contact-extra-fields-v2` | Column add | `contacts.ts` | ⚪ pending |
| 039 | `039-custom-field-definitions` | Port verbatim | `custom_fields.ts` | ⚪ pending |
| 040 | `040-custom-field-values` | Port verbatim | `custom_fields.ts` | ⚪ pending |

### Migrations 041–050 — Notes unification + Decision logs

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 041 | `041-contact-notes` (legacy contact_notes — superseded by 052) | Skip — 052 unifies | — | ⚪ pending |
| 042 | `042-meeting-notes-source` (source column on notes) | Subsumed by unified notes | `notes.ts` | ⚪ pending |
| 043 | `043-user-preferences` (user_preferences table) | Port verbatim | `settings.ts` | ⚪ pending |
| 044 | `044-company-decision-logs` (company_decision_logs table) | Port verbatim | `companies.ts` | ⚪ pending |
| 045 | `045-portfolio-company-fields` | Column add (portfolio investment fields) | `companies.ts` | ⚪ pending |
| 046 | `046-builtin-field-defs` | 🔁 repair-script (seed builtin defs) | data-migration | ⚪ pending |
| 047 | `047-backfill-normalized-names` | 🔁 repair-script | data-migration | ⚪ pending |
| 048 | `048-contact-field-sources` (source-of-truth tracking on contact fields) | Port verbatim | `contacts.ts` | ⚪ pending |
| 049 | `049-custom-field-section` (section column on custom_fields) | Column add | `custom_fields.ts` | ⚪ pending |
| 050 | `050-company-field-sources` | Port verbatim | `companies.ts` | ⚪ pending |

### Migrations 051–060 — Unified notes + Speaker links

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 051 | `051-contact-decision-logs` | Port verbatim | `contacts.ts` | ⚪ pending |
| 052 | `052-unified-notes` (UNIFIED `notes` table — replaces company_notes + contact_notes) | Port verbatim — **architectural keystone** | `notes.ts` | ⚪ pending |
| 053 | `053-convert-manual-notes` | 🔁 repair-script | data-migration | ⚪ pending |
| 054 | `054-notes-fts5` | Rewrite as tsvector + GIN | `notes.ts` | ⚪ pending |
| 055 | `055-speaker-contact-links` (speaker_contact_links table) | Port verbatim | `meetings.ts` | ⚪ pending |
| 056 | `056-company-new-fields` | Column add | `companies.ts` | ⚪ pending |
| 057 | `057-notes-folder-path` | Column add | `notes.ts` | ⚪ pending |
| 058 | `058-note-folders` (note_folders table) | Port verbatim | `notes.ts` | ⚪ pending |
| 059 | `059-partner-meeting` (partner_meeting_digests + partner_meeting_items) | Port verbatim | `partner_meeting.ts` | ⚪ pending |
| 060 | `060-repair-own-company-contacts` | 🔁 repair-script | data-migration | ⚪ pending |

### Migrations 061–070 — Partner meeting + Repair + Talent pipeline

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 061 | `061-partner-meeting-linked-meeting` | Column add | `partner_meeting.ts` | ⚪ pending |
| 062 | `062-repair-owner-linkedin-url` | 🔁 repair-script | data-migration | ⚪ pending |
| 063 | `063-remove-notification-contacts` | 🔁 repair-script (table drop) | data-migration | ⚪ pending |
| 064 | `064-calendar-event-dedup` | Index + 🔁 repair-script | `meetings.ts` + data-migration | ⚪ pending |
| 065 | `065-repair-imported-note-frontmatter` | 🔁 repair-script | data-migration | ⚪ pending |
| 066 | `066-contact-linkedin-fields` | Column add | `contacts.ts` | ⚪ pending |
| 067 | `067-repair-company-view-flag` | 🔁 repair-script | data-migration | ⚪ pending |
| 068 | `068-contact-talent-pipeline` (talent_pipeline enum on contacts) | Column add | `contacts.ts` | ⚪ pending |
| 069 | `069-contact-key-takeaways` (key_takeaways column on contacts) | Column add | `contacts.ts` | ⚪ pending |
| 070 | `070-company-key-takeaways` (key_takeaways column on companies) | Column add | `companies.ts` | ⚪ pending |

### Migrations 071–080 — Portfolio + Chat sessions

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 071 | `071-meeting-dismissed-companies` | Port verbatim | `meetings.ts` | ⚪ pending |
| 072 | `072-company-portfolio-fund` (portfolio_fund FK) | Port verbatim | `companies.ts` | ⚪ pending |
| 073 | `073-portfolio-investment-fields` | Column add | `companies.ts` | ⚪ pending |
| 074 | `074-backfill-company-domains` | 🔁 repair-script | data-migration | ⚪ pending |
| 075 | `075-company-investors-position` | Column add | `companies.ts` | ⚪ pending |
| 076 | `076-lead-investor-company-id` | FK column | `companies.ts` | ⚪ pending |
| 077 | `077-industry-consolidation` | 🔁 repair-script | data-migration | ⚪ pending |
| 078 | `078-chat-sessions` (chat_sessions + chat_session_messages + FTS) | Port verbatim — add `citations jsonb` in M5 | `chat.ts` | ⚪ pending |
| 079 | `079-drop-company-conversations` | 🔁 repair-script (table drop) | data-migration | ⚪ pending |
| 080 | `080-backfill-meeting-chats` | 🔁 repair-script | data-migration | ⚪ pending |

### Migrations 081–095 — Final state

| # | Source migration | Disposition | Target schema file | Status |
|---|---|---|---|---|
| 081 | `081-drop-legacy-notes-tables` | 🔁 repair-script (table drops) | data-migration | ⚪ pending |
| 082 | `082-notes-source-meeting-unique` | Partial UNIQUE index | `notes.ts` | ⚪ pending |
| 083 | `083-flagged-files-mime-type` | Column add | `companies.ts` (flagged_files) | ⚪ pending |
| 084 | `084-repair-bad-primary-domains` | 🔁 repair-script | data-migration | ⚪ pending |
| 085 | `085-memo-evidence` (memo_evidence table) | Port verbatim | `memos.ts` | ⚪ pending |
| 086 | `086-agent-runs` (agent_runs table) | Port verbatim | `agents.ts` | ⚪ pending |
| 087 | `087-agent-run-events` | Port verbatim | `agents.ts` | ⚪ pending |
| 088 | `088-portfolio-stage-backfill` | 🔁 repair-script | data-migration | ⚪ pending |
| 089 | `089-transcript-summaries` (transcript_summaries table) | Port verbatim | `meetings.ts` | ⚪ pending |
| 090 | `090-memo-evidence-section` | Column add + partial UNIQUE | `memos.ts` | ⚪ pending |
| 091 | `091-agent-runs-cache-tokens` | Column add | `agents.ts` | ⚪ pending |
| 092 | `092-stress-test-reports` | Port verbatim | `stress_test.ts` | ⚪ pending |
| 093 | `093-stress-test-reports-no-fk` | 🔁 repair-script (FK drop) | data-migration | ⚪ pending |
| 094 | `094-agent-runs-drop-version-fk` | 🔁 repair-script (FK drop) | data-migration | ⚪ pending |
| 095 | `095-priority-rename-further-work` | 🔁 repair-script (rename) | data-migration | ⚪ pending |

---

## Verification queue (Phase 0.2 acceptance)

After each domain schema file is complete, run:

1. `drizzle-kit generate` produces a clean migration SQL
2. Apply against a fresh local Postgres DB
3. Inspect with `psql \\d+ <table>` — verify columns, types, indexes, FKs
4. Compare against the SQLite source schema via a generated diff report
5. `EXPLAIN ANALYZE` for the 10 hottest queries on a 10x-sized test DB:
   - calendar today (next-meeting lookup by start time)
   - listMeetings (paginated, recent)
   - listCompanies (filtered by stage)
   - listContacts (with touchpoint denormalization)
   - universal search across 4 entity types (tsvector + GIN)
   - meeting detail (joins meetings + transcripts + speakers + companies)
   - company detail (joins companies + meetings + contacts + notes)
   - contact detail (joins contacts + meetings + notes + companies)
   - chat session messages (paginated)
   - audit log recent (filtered by event_type)
6. Measure GIN index size in MB; refuse merge if > 2x expected
