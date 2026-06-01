# Runbook: OAuth refresh-token reuse detected

## What you're looking at

Sentry alert with tag `security: oauth_token_reuse`, fingerprinted by `client_id`. The alert fires when an already-rotated OAuth refresh token is presented to `/oauth/token` (grant_type=refresh_token).

Refresh-token reuse is **always one of**:

1. **Token theft** — an attacker captured a refresh token and used it after the legitimate client rotated it. Real security incident.
2. **Client bug** — the client kept the old refresh token alive after rotation (race condition, retry loop after a network blip, multiple instances of the same client sharing storage). Annoying but not malicious.
3. **Replay during deployment** — extremely rare; an in-flight refresh from one process raced a rotated token from another. Bounded; resolves itself.

You can't distinguish (1) from (2) without context. Treat as (1) until you have evidence otherwise.

## Immediate response (T+0 to T+15 min)

1. **Note the affected client_id from the Sentry alert.** It's the fingerprint key — also in the `extra` block.
2. **Identify the user(s) affected.** Query:
   ```sql
   SELECT DISTINCT account_id FROM oauth_refresh_tokens
   WHERE client_id = '<client_id>' AND revoked_at IS NOT NULL
   ORDER BY revoked_at DESC LIMIT 20;
   ```
   The library auto-revoked the entire grant chain on detection, so all of this client's refresh tokens for the affected user are already dead. Active access tokens (15-min TTL) will still work until expiry.
3. **Notify the affected user(s) out-of-band.** Slack DM / email. Say:
   > "Cyggie detected an unusual access pattern from <client_name>. Your active sessions for that app have been ended as a precaution. Re-authorize via <client> to restore access. Reply if this is unexpected."

## Triage (T+15 min to T+1 hr)

Determine which of the three cases this is.

### Case 1 — Token theft (most concerning)

Signals:
- Multiple distinct IPs in the recent `mcp_audit` calls for this client_id (use the audit log added in slice 7).
- Geographic anomaly (logs show a sudden new region for this client).
- User reports they didn't see the original consent screen / didn't install this client.

Response:
- Hard-revoke the client: `UPDATE oauth_clients SET payload = jsonb_set(payload, '{revoked}', 'true'::jsonb) WHERE client_id = '<client_id>'`. (Soft delete via revoked flag; full DELETE is fine too but loses the audit trail.)
- For all affected users, also rotate their gateway JWT signing secret if other clients are also showing weird behavior. (Heavy; only if you suspect the secret itself leaked — different threat model.)
- File a security incident note in the team channel.

### Case 2 — Client bug

Signals:
- Same IP, same user-agent across all the legit-looking traffic + the reuse attempt.
- Reuse attempt is within ~seconds of a successful rotation (race) rather than minutes/hours.
- User confirms they didn't change anything; just opened the client.

Response:
- File a bug against the client implementation. Cyggie's library-level cascade revocation is working as designed — the client needs to handle the rotated-token error gracefully (re-run the refresh, then retry the original request).
- For Cyggie-built clients (Slack bot, future browser extension): track the bug in the per-client issue tracker.
- For third-party clients: provide the user a "click to reset" link that revokes any lingering tokens and starts a fresh authorize flow.

### Case 3 — Deployment race

Signals:
- Single user, single client, single reuse event.
- Timestamp aligns with a recent Fly deploy or restart.
- Doesn't repeat.

Response:
- Document the incident, close the alert. No action.

## Post-incident

- Update this runbook with anything you learned. The pattern repeats — what was hard to find this time, leave a note for next time.
- If Cases 1 or 2 are repeating, consider:
  - Adding a "concurrent-refresh tolerance" window (currently 0s — multi-firm TODO calls for 60s grace).
  - Adding client-side telemetry (the client reports its own rotation events; we cross-check).

## Why this isn't paging-worthy by default

Refresh-token reuse for a single user × single client is bounded:
- The library auto-revoked the chain. No further damage.
- Access tokens already issued have ≤15 min to live.
- User can re-authorize via their normal flow.

Worth investigating, not worth waking up for. Page only if:
- Same client_id fires > 5 distinct reuse events within 1 hour (suggests pattern, not random).
- Reuse correlates with other Sentry security events (e.g., `slack_token_revoked`).

## Related

- `runbooks/oauth-mass-expiry.md` — for when ALL users hit reauth at once (different problem).
- Plan: [`~/.claude/plans/let-s-start-scoping-out-majestic-lecun.md`](file:///Users/sandersoncass/.claude/plans/let-s-start-scoping-out-majestic-lecun.md) — decision-log #9 (60s grace window, multi-firm TODO).
