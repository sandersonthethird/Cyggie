# scripts/migrate-sqlite-to-postgres

One-time data migration tool: reads from the desktop's `~/Documents/MeetingIntelligence/echovault.db` and writes to Neon Postgres via `@cyggie/db` drizzle schema. Phase 0.3 of the [mobile V1 plan](../../../.claude/plans/claude-code-prompt-jolly-eagle.md).

## Prerequisites

1. Phase 0.2 schema applied to Neon (drizzle migrations 0000–0005).
2. A `users` row in Neon — created via OAuth (Phase 0.6) OR seeded manually for dev.
3. `GATEWAY_DATABASE_URL` set in `.env.local`.
4. Read-only access to `~/Documents/MeetingIntelligence/echovault.db`. **Use a copy if the desktop app is running** — SQLite WAL mode is tolerant but a copy is safer.

## Usage

```bash
# Seed a dev user if you don't have one yet:
node --env-file=.env.local --input-type=module -e "
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.GATEWAY_DATABASE_URL)
const id = 'dev-user-' + Date.now()
await sql\`INSERT INTO users (id, google_sub, email, display_name)
          VALUES (\${id}, 'dev', 'sandy.cass@gmail.com', 'Sandy (dev)')\`
console.log('seeded:', id)
"

# Dry run (validates transforms on one row per table, doesn't write):
node --env-file=.env.local --experimental-strip-types \
     scripts/migrate-sqlite-to-postgres/index.ts \
     --sqlite=$HOME/Documents/MeetingIntelligence/echovault.db \
     --user-id=<users.id> \
     --dry-run

# Real run:
node --env-file=.env.local --experimental-strip-types \
     scripts/migrate-sqlite-to-postgres/index.ts \
     --sqlite=$HOME/Documents/MeetingIntelligence/echovault.db \
     --user-id=<users.id>

# One table at a time (useful for debugging):
node --env-file=.env.local --experimental-strip-types \
     scripts/migrate-sqlite-to-postgres/index.ts \
     --sqlite=$HOME/Documents/MeetingIntelligence/echovault.db \
     --user-id=<users.id> \
     --table=meetings
```

## How it works

```
  SQLite                   Transform               Neon Postgres
  ──────                   ─────────               ─────────────
  echovault.db             • TEXT timestamps        target schema in
   │  read-only, via         → timestamptz          @cyggie/db
   │  node:sqlite          • 0/1 → boolean              │
   │                       • JSON-in-TEXT               │
   │                          → jsonb                   │
   ▼                       • stamp user_id              ▼
  rows ────────────────────────────────────────────▶ ON CONFLICT
  (streamed                Migrator.transform        (id) DO NOTHING
   batched 500)                  │                     │
                                 ▼                     ▼
                          unknown[] params       migration_progress
                                                 (checkpoint table)
```

Per-table state lives in `migration_progress` (defined in the gateway schema). Restart-safe: re-running picks up failed/incomplete tables.

## Migrator coverage (V1 critical path)

| Layer | Tables |
|---|---|
| 1 (no FK deps) | `templates`, `themes`, `pipeline_configs`, `speakers` |
| 2 | `pipeline_stages`, `org_companies` |
| 3 | `org_company_aliases`, `contacts` |
| 4 | `contact_emails`, `meetings` |
| 5 | `meeting_speakers`, `meeting_company_links`, `meeting_speaker_contact_links`, `notes`, `note_folders`, `tasks`, `chat_sessions`, `chat_session_messages` |

**Total: 18 tables.** Remaining ~22 tables (custom_fields, decision_logs, partner_meeting, deals, memos, agents, stress_test, settings, flagged_files, investors, transcript_summaries, org_company_contacts, company_investors) follow the same migrator pattern and are added incrementally.

## Repair-script integration (post-data-migration)

These SQLite migrations are tracked as `🔁 repair-script` in [MIGRATION_AUDIT.md](../../packages/db/MIGRATION_AUDIT.md) and run AFTER bulk data migration succeeds:

- 010 (clear company cache)
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

Plus the contact-touchpoint denormalization backfill (last_meeting_at, last_email_at) noted in [contacts.ts](../../packages/db/src/schema/contacts.ts).

These are deferred to a future script (`scripts/data-quality-passes.ts`) — not blocking initial migration.
