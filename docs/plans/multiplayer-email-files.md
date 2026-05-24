# Multiplayer email + file context — implementation plan

Generated from a `/grill-me` design session on 2026-05-24. See conversation for the full design tree and rationale behind each decision.

## Design summary

### Multiplayer email
- **Posture 2** privacy: AI synthesizes firm-wide; humans see only their own emails. Enforced at gateway with two scopes (`user`, `firm-ai`); desktop re-filters defensively. AI output post-filter blocks long verbatim quotes.
- **Storage**: bodies in Neon (default AES-256 at rest), no app-level encryption v1. No attachment storage — partners save important attachments to shared Drive manually.
- **Schema**: `email_accounts` adds `owner_user_id`; canonical `email_threads` (dedup on `rfc_message_id_hash`); canonical `email_messages` (dedup on Message-ID); `email_thread_owners(thread_id, user_id, personal BOOLEAN)` join. `INSERT … ON CONFLICT DO NOTHING` for canonical rows; unconditional `INSERT` for owner join.
- **Ingest**: each partner's desktop pulls their firm Gmail via existing `company-email-ingest.service.ts`. OAuth tokens stay local in `safeStorage`. Scope: firm-meeting-triggered (any firm contact, not just user's personal meetings). Backfill bounded by partner's firm-email tenure.
- **Initial multiplayer migration**: one-shot bulk seed endpoint at the gateway; ongoing sync via outbox.
- **Embeddings**: pgvector in Neon, per-thread, gateway-computed on outbox arrival with 30s debounce.
- **Privacy controls**: per-Contact "personal" toggle (rare); most-restrictive-wins on mixed-participant threads; personal flag affects AI/firm visibility only, not what recipients see in their own UI.
- **UI**: invisible multiplayer in email list (each partner sees only their own). Single firm-wide signal at top of contact page: "Last firm touch: [partner], [time]".
- **Retention**: data stays when partner leaves (firm IP); "(former)" label on attribution; admin-only purge as legal escape hatch.

### Multiplayer file context (architecture change to existing `company_flagged_files`)
- **Trigger**: manual star toggle (existing UI). Extraction now runs at flag time, not query time.
- **Where extraction runs**: desktop main process (reuse existing `readLocalFile`).
- **Persisted**: extracted text + `drive_version` + `flagged_by_user_id` + `extracted_at` + `extraction_status`. Add columns; add table to `OWNED_TABLES`; outbox sync to Neon.
- **Embeddings**: gateway computes per-row on outbox arrival, stored in Neon-only `vector(1536)` column.
- **Multiplayer**: firm-scoped flag (no per-user join). Latest flag UPSERTs content + version. Star visible to every partner; "flagged by [partner], [time]" label below filename.
- **Refresh UX**: explicit "↻ refresh" button per file. No background polling, no staleness checks.
- **Query path**: `assembleCompanyContext` reads pre-extracted text from SQLite row; remove on-demand `readLocalFile` calls. AI retrieval unifies email threads + flagged files by `company_id`.
- **Privacy**: flagging is an explicit firm-share gesture; no per-user gating on file content.

### Deferred (minor)
- AI citation format: metadata-only for cross-partner email sources; full filename for flagged files.
- Audit logging: deferred to v2 unless a partner asks "what does the AI see?"
- Gmail threading edge cases: dedupe via RFC `Message-ID` chain at gateway receive path.

---

## 10 vertical slices

### File-context architecture change (3 slices, ships independently)

#### 1. Pre-extract text at flag time + refresh button + status UI — AFK
- **Blocked by**: none
- Flagging in CompanyFiles runs `readLocalFile` synchronously; persist text into `company_flagged_files` (new columns: `extracted_text`, `extracted_text_chars`, `drive_version`, `flagged_by_user_id`, `extraction_status`, `extraction_error`, `extracted_at`)
- UI: "extracting…" indicator, error state with retry, "↻ refresh" button per file
- `assembleCompanyContext` / `formatFlaggedFilesSection` read pre-extracted text instead of calling `readLocalFile`
- Best-effort backfill for existing flagged rows
- Single-user only, SQLite-only, no Neon touch
- ✅ Flag triggers inline extraction; row contains text after success
- ✅ AI query about a company is observably faster (no PDF parse per query)
- ✅ Refresh button re-fetches + UPSERTs with new `drive_version`
- ✅ Extraction failure surfaces inline with retry control

#### 2. Sync flagged files to Neon + "flagged by" attribution + multiplayer UPSERT — AFK ⚠️ Neon schema
- **Blocked by**: 1
- `company_flagged_files` joins `OWNED_TABLES` with unconditional UPSERT on `UNIQUE(company_id, file_id)`
- Neon migration: matching table with same columns
- Gateway sync apply route handles upsert
- UI renders "flagged by [partner name], [time]" below each filename
- Initial sync pushes existing rows
- ✅ Partner A flags; Partner B's SQLite receives row after sync; B's star renders correctly
- ✅ Partner B re-flags or refreshes; row updates with B's name + version; A's machine reflects after sync
- ✅ Unflagging on any machine removes for everyone
- ✅ Neon migration applies cleanly with `(company_id, file_id)` unique constraint

#### 3. Gateway embeddings for flagged files — AFK ⚠️ Neon column
- **Blocked by**: 2
- Gateway worker subscribes to `company_flagged_files` insert/update
- On non-empty `extracted_text`, compute embedding (`text-embedding-3-small` or chosen model) into Neon-only `embedding vector(1536)` + `embedded_at` + `embedding_model`
- 30s debounce per row
- No SQLite sync of embedding column
- ✅ Flag a file; within 30s Neon row has non-null embedding
- ✅ Re-flag with new content; embedding regenerates
- ✅ Embedding worker survives gateway restart (resumes pending work)

### Multiplayer email (7 slices)

#### 4. Multi-owner local schema + firm-meeting-triggered ingest — AFK
- **Blocked by**: none
- SQLite migrations: add `owner_user_id` to `email_accounts`; create `email_thread_owners(thread_id, user_id, personal BOOLEAN, ingested_at)` with `UNIQUE(thread_id, user_id)`; backfill from current user
- `company-email-ingest.service.ts` switches scope from personal-meeting attendees to firm-wide Contact/Company list; bounded-rate first-run backfill
- Every ingest row tags `owner_user_id`
- Still local-only
- ✅ Existing emails display unchanged
- ✅ `email_thread_owners` populated for every existing thread
- ✅ Connecting Gmail ingests emails for firm contacts the user has never personally met
- ✅ Backfill rate-limit prevents Gmail-API quota exhaustion

#### 5. Neon email schema + outbox sync with canonical dedup — AFK ⚠️ Neon schema (heavy)
- **Blocked by**: 4
- Neon migrations: `email_accounts`, `email_threads` (with `rfc_message_id_hash` unique + `embedding vector(1536)`), `email_messages` (Message-ID unique), `email_message_participants`, `email_thread_owners`, `email_contact_links`, `email_company_links`; indexes incl. pgvector ivfflat
- Add tables to `OWNED_TABLES`; sync specs use `INSERT … ON CONFLICT DO NOTHING` for canonical, `INSERT … ON CONFLICT (thread_id, user_id) DO NOTHING` for owner join
- Gateway apply route resolves identity via Message-ID linkage for threading edge cases
- ✅ Partner A ingests thread X; Neon canonical row created; A's owner-join row created
- ✅ Partner B later ingests same thread; canonical row not duplicated; B's owner-join row added
- ✅ Different per-mailbox Gmail thread IDs still resolve to one canonical thread via Message-ID chain
- ✅ No raw email data visible cross-partner in any query path yet

#### 6. Bulk seed endpoint + migration UI — AFK
- **Blocked by**: 5
- Gateway endpoint `POST /seed/emails` accepts batched payloads (~1k threads + messages per batch) through same canonical-dedup logic
- Desktop seeder streams existing SQLite email history with progress UI ("Syncing email history… X / Y threads")
- Normal incremental sync resumes after completion
- ✅ Existing single-user partner upgrades; full history lands in Neon in minutes
- ✅ Re-running seed is idempotent
- ✅ Failure mid-seed resumes from where it left off
- ✅ Embedding worker drains queue post-seed without pinning resources

#### 7. Per-Contact "personal" toggle + most-restrictive-wins — AFK
- **Blocked by**: 5
- Toggle on Contact detail page; IPC `CONTACT_SET_PERSONAL(contact_id, personal)` flips `personal = true` on all `email_thread_owners` rows for current user where threads contain this contact
- Propagates via outbox
- Most-restrictive-wins at query time: any thread where any owner has `personal = true` excluded from firm-AI scope
- Personal flag does not hide thread from other recipients' own UI views
- ✅ Sandy toggles personal for Jane; firm-AI memo no longer pulls Sandy's threads with her
- ✅ Other partners on same threads still see them in their own email lists
- ✅ Toggle off restores firm-AI visibility

#### 8. Gateway read scopes + verbatim post-filter + "last firm touch" UI — AFK
- **Blocked by**: 5, 7
- Gateway query helpers split into `user` scope (`WHERE email_thread_owners.user_id = $1`) for UI IPCs and `firm-ai` scope (`WHERE personal = false`) for AI endpoints
- Desktop UI re-filters defensively
- AI output post-filter: scan generated responses for verbatim substrings >80 chars from any retrieved source the caller doesn't own; regenerate or paraphrase
- New IPC `CONTACT_LAST_FIRM_TOUCH(contact_id)` returns latest email metadata across all owners; rendered as subtitle: "Last firm touch: [partner], [time]"
- ✅ Partner B's email-list view of Jane shows only her own emails
- ✅ AI memo about Jane retrieves all firm-visible threads including Partner A's
- ✅ Prompting AI to quote Partner A's email verbatim produces paraphrased output
- ✅ "Last firm touch" appears with correct attribution

#### 9. Per-thread email embeddings + unified AI retrieval (headline feature) — AFK
- **Blocked by**: 5, 8; pairs with 3
- Gateway worker computes thread embeddings on outbox arrival; new messages on existing threads trigger re-embed with 30s debounce
- Memo context assembler runs unified retrieval query joining `email_threads` (firm-ai scope) UNION `company_flagged_files` (from slice 3), ranked by cosine distance, top-k 15
- AI prompt receives mixed-source context with provenance labels per chunk
- Citations: metadata-only for cross-partner emails ("based on Sandy's correspondence with Jane"); full filename for flagged files
- ✅ Memo about AcmeCorp pulls both relevant emails and flagged files into context
- ✅ Top-k retrieval semantically prioritizes most relevant items
- ✅ Citations reference provenance correctly
- ✅ Personal-flagged threads excluded from retrieval

#### 10. Partner deactivation + "(former)" attribution + admin purge — AFK
- **Blocked by**: 8
- Admin-only deactivate-user gateway endpoint sets `users.deactivated_at`, revokes OAuth refresh tokens, does NOT delete email rows
- UI attribution rendering joins on `deactivated_at`, appends " (former)" when set
- Admin-only purge endpoint cascade-deletes a user's `email_thread_owners` + GCs canonical threads with zero owners
- ✅ Deactivated partner's emails still feed AI memos
- ✅ Attribution labels show "[Name] (former)" everywhere
- ✅ Purge endpoint requires admin auth, removes contributions cleanly
- ✅ Reactivation supported (clear `deactivated_at`, partner reconnects Gmail)

---

## Dependency graph

```
1 → 2 → 3
4 → 5 → 6
        → 7
        → 8 → 9 (also needs 3)
            → 10
```

Slices 1–3 (file context) can ship in parallel with 4 (email ingest scope). Longest critical path: 4 → 5 → 8 → 9.

## Notes
- **Neon migrations** (extra care): slices 2, 3, 5. Slice 5 is heaviest — canonical-dedup schema with pgvector indexes. Worth a dedicated review pass.
- **Headline value lands at slice 9** — AI memos become firm-wide-intelligent.
- **Minimum viable multiplayer**: slices 4–8 ship a usable (if AI-dumb) multiplayer system.

## Critical files referenced

- `src/main/services/company-email-ingest.service.ts` — Gmail ingest
- `src/main/services/sync-pull.service.ts`, `src/main/services/sync-remote-apply.ts`, `src/main/services/sync-bootstrap.ts` — sync engine
- `api-gateway/src/routes/sync.ts` — gateway sync apply route
- `packages/db/src/sqlite/migrations/` — SQLite migrations (latest mid-080s)
- `packages/db/src/sqlite/repositories/` — repo barrel (sync-wrapped)
- `packages/db/src/sync/owned-tables.ts` — registers tables for outbox sync
- `src/renderer/components/company/CompanyFiles.tsx` — flagging UI
- `src/main/storage/file-manager.ts` — `readLocalFile()` extraction
- `src/main/services/chat/context-builders.ts`, `context-formatters.ts` — AI context assembly
- `src/main/calendar/google-auth.ts` — Google OAuth handling
- `packages/db/src/sqlite/migrations/013-company-os-email.ts` — existing email schema baseline
- `packages/db/src/sqlite/migrations/035-...`, `083-...` — existing `company_flagged_files` schema
