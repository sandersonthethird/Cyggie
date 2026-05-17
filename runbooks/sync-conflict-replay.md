# Runbook: Sync conflict replay

**When this fires:** Phase 1.5 bidirectional sync surfaces a conflict that the lamport-clock LWW resolver couldn't decide — typically because a row was deleted on one side and edited on the other.

Datadog alert: `sync_conflicts_total{resolution=manual_review}` > 0.

## Diagnose

Find the conflicting outbox entries:

```sql
SELECT id, user_id, device_id, table_name, row_id, op, lamport, created_at
FROM outbox
WHERE acked_at IS NULL
ORDER BY created_at;
```

Inspect the conflicting row in both stores:

```sql
-- Postgres (gateway truth)
SELECT * FROM meetings WHERE id = '<row_id>';

-- SQLite (desktop truth) — run on the user's Mac
sqlite3 ~/Documents/MeetingIntelligence/echovault.db \
  "SELECT * FROM meetings WHERE id = '<row_id>'"
```

## Fix

The conflict resolution decision tree:

```
   Desktop side       Postgres side       Resolution
   ──────────         ─────────────       ──────────
   exists, edited     exists, edited      lamport LWW (automatic; if this
                                          fires, it means clocks tied — pick
                                          Postgres as canonical and log)
   exists, edited     deleted             Restore from desktop's last edit
                                          (re-insert into Postgres)
   deleted            exists, edited      Postgres edits win (delete propagates
                                          backward); flag for user notification
   exists, edited     missing entirely    Insert into Postgres
   missing entirely   exists, edited      Sync agent applies to desktop
```

Manual reconciliation:

```bash
# Force-apply a specific outbox entry, ignoring its current state
node --env-file=.env.local --experimental-strip-types \
  scripts/sync-replay.ts \
  --outbox-id=<id> \
  --force=true  # bypass lamport comparison
```

(Script lands in Phase 1.5; this runbook documents the design.)

## Recovery verification

```sql
SELECT count(*) FROM outbox WHERE acked_at IS NULL AND created_at < now() - interval '1 hour';
```

Should be 0. If non-zero entries persist, escalate — there's likely a schema mismatch between desktop and Postgres that's blocking application.
