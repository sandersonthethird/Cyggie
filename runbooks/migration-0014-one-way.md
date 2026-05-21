# Runbook: Migration 0014 — per-user calendar_event_id (ONE-WAY)

**When this matters:** deploying / rolling back the gateway around migration 0014.

This migration replaces the global-unique partial index
`meetings_calendar_event_idx` with a per-user composite
`meetings_user_calendar_event_idx`. **It is one-way once the mobile
clients start writing.**

## Why it cannot be rolled back

Pre-0014: only one row in `meetings` could carry a given
`calendar_event_id`. After 0014 ships, the mobile tap-to-view flow
(`POST /meetings/from-calendar-event`) lets two users invited to the
same Google calendar event each get their own row — keyed by
`(user_id, calendar_event_id)`.

As soon as a second user taps a shared event, the table contains
duplicate `calendar_event_id` values across users. The old
`meetings_calendar_event_idx` (global unique on
`calendar_event_id WHERE NOT NULL`) **cannot be recreated** without
deleting one of the user's rows. Doing so loses notes,
recordings, and audit history for that user.

```
  PRE-0014 (global)            POST-0014 (per-user)
  ─────────────────            ────────────────────
  one row per cal_event_id     one row per (user, cal_event_id)

  Alice's tap → row A          Alice's tap → row A
  Bob's tap   → 23505 (FAIL)   Bob's tap   → row B
```

## Deployment order

1. **Apply the migration** to Neon **BEFORE** deploying the gateway
   code. The gateway code assumes per-user uniqueness — if it ships
   first against the old index, every second-user tap fails with
   23505 instead of succeeding.

2. **Run statements OUTSIDE a transaction.** `CONCURRENTLY` requires
   it. Drizzle's migrator wraps each `.sql` file in a tx by default;
   run via raw `psql` or the helper below.

3. **Verify both indexes coexist briefly** during the CREATE step
   (Postgres allows it; CONCURRENTLY does not take a lock-window
   that breaks reads).

```sh
# Connect to Neon
psql "$GATEWAY_DATABASE_URL"

# Step 1 — non-blocking create. Takes longer than naive CREATE INDEX
# but no write lock. Watch with: SELECT * FROM pg_stat_progress_create_index;
\timing on
CREATE UNIQUE INDEX CONCURRENTLY "meetings_user_calendar_event_idx"
  ON "meetings" ("user_id", "calendar_event_id")
  WHERE "calendar_event_id" IS NOT NULL;

# Step 2 — drop the old index. Also CONCURRENTLY (lock-free).
DROP INDEX CONCURRENTLY "meetings_calendar_event_idx";

# Verify
SELECT indexname FROM pg_indexes WHERE tablename='meetings'
  AND indexname LIKE 'meetings_%calendar%';
# Expect: meetings_user_calendar_event_idx
```

## What can still be done if a rollback is genuinely needed

(Pre-mobile-adoption only.) If 0014 just shipped and no mobile client
has been built yet:

```sql
-- Only safe BEFORE mobile starts writing cross-user duplicates.
CREATE UNIQUE INDEX CONCURRENTLY "meetings_calendar_event_idx"
  ON "meetings" ("calendar_event_id")
  WHERE "calendar_event_id" IS NOT NULL;

DROP INDEX CONCURRENTLY "meetings_user_calendar_event_idx";
```

If the new index already has duplicates: the rollback `CREATE` will
fail with 23505 and leave an INVALID index. There is no recovery
short of choosing which user's data to delete.

## Recovery if CREATE fails mid-build

If the deploy fails partway through:

```sql
-- The partial index ends up in INVALID state. Check:
SELECT indexrelid::regclass, indisvalid
  FROM pg_index
  WHERE indexrelid::regclass::text = 'meetings_user_calendar_event_idx';

-- If indisvalid = false:
DROP INDEX CONCURRENTLY "meetings_user_calendar_event_idx";

-- Then re-run the CREATE statement.
```

The old `meetings_calendar_event_idx` remains intact during a failed
CREATE — writes keep working through the existing constraint.

## Audit hook

A failed migration deploy leaves a `metric=migration.0014.failed`
log entry. Surface in Sentry; pages the on-call engineer.
