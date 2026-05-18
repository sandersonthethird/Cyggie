# Runbook: Recording stuck in finalize

**When this fires:** a recording's `status` stays in `transcribed` or `partial_final` for >2 hours without progressing to `summarized` or `finalized`. Alert spec (V1: emitted as `metric=recording.session_duration_seconds` pino log field + manual SQL check below; full time-series alert lands with the Phase 2 observability platform): p99 finalize tail exceeds 30 min.

## Diagnose

Find stuck sessions:

```sql
SELECT id, user_id, title, status, updated_at, duration_seconds
FROM meetings
WHERE status IN ('transcribed', 'recording')
  AND updated_at < now() - interval '2 hours'
ORDER BY updated_at DESC;
```

Check what's missing per the two-stage finalize design (plan §M3/M4):

| Status | Expected state | If stuck |
|---|---|---|
| `recording` | Active WS session | No active WS — orphaned. Mark errored. |
| `transcribed` | Stage 1 summary generating | Anthropic call hung or never started — re-trigger. |
| `partial_final` | Awaiting canonical WAV upload | Phone never uploaded — 24hr timeout should have fired. |

Anthropic API health: https://status.anthropic.com. If Anthropic is degraded, summaries queue up.

## Fix

Manual stage-1 retrigger (for `transcribed` sessions):

```bash
# TODO (Phase 0.5+): admin route that re-runs summarizer for a specific meeting
curl -X POST $GATEWAY/admin/meetings/$MEETING_ID/resummarize \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

For now, this runbook documents the intent — implementation lands when the recording pipeline does (M3).

Manual stage-2 (canonical-derived) retrigger: same endpoint, queries R2 for the canonical WAV first; if missing, accepts the partial as final.

## Recovery verification

```sql
-- Should drop to 0
SELECT count(*) FROM meetings WHERE status = 'transcribed' AND updated_at < now() - interval '2 hours';
```
