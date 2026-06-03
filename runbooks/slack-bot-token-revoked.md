# Runbook: Slack bot token revoked

## What you're looking at

Sentry alert with tag `security: slack_token_revoked` (or a pino error line `metric=slack_token_revoked`). Fired when Slack's `users.info` API returns `invalid_auth` or `not_authed` while [`resolveSlackUser`](../api-gateway/src/slack/user-mapping.ts) is trying to upgrade a Slack ID → Cyggie user.

Concretely: the gateway tried to call Slack with `SLACK_BOT_TOKEN` and Slack said "this token is no longer valid." The bot will continue responding to existing slash commands (and Cyggie data still flows to the user — mapping is best-effort enrichment per plan Q7), but every `users.info` lookup will fail. New audit rows lose `on_behalf_of_user_id` accuracy until the token is replaced.

A handful of failure modes look identical from the gateway's vantage point:

1. **Admin manually revoked the install** (Slack workspace admin → Apps → Cyggie → remove). Real configuration event.
2. **Bot was uninstalled by accident** (admin deleted the install when meaning to delete a different app).
3. **Bot scopes changed and the old token was invalidated** (Slack invalidates the token whenever the app's scope set changes).
4. **Token leaked + manually rotated by the admin** (security response — somebody noticed the token in a screenshot/repo and rotated it).

The bot doesn't get to know which one.

## Immediate response (T+0 to T+15 min)

1. **Confirm the alert isn't a flap.** Search Sentry for `tag:security:slack_token_revoked` over the last hour. A single hit during a recent deploy is suspicious but maybe transient (Slack has occasional auth glitches). >2 hits, or a steady stream, means the token really is dead.
2. **Note the timestamp of the first failure.** That's roughly when the token was revoked.
3. **Tell the Slack workspace it's down**, if anyone's actively using the bot. Post in the team channel:
   > "Cyggie's Slack integration is offline. Bot answers may be missing user attribution. Investigating; ETA <best guess>."
4. **Check the gateway is otherwise healthy.** [Fly logs](https://fly.io/apps/cyggie-gateway/logs) — is the gateway still serving requests? Slack token revocation doesn't affect anything else, but easy to rule out at the same time.

## Triage (T+15 min to T+1 hr)

Determine which of the four cases this is.

### A. Was it an admin action?

Ask the Slack workspace admin. If they removed or reinstalled the app intentionally, that's the answer. Skip to "Reinstall."

### B. Did Slack invalidate from a scope change?

Look at recent commits to:
- [`api-gateway/src/slack/route.ts`](../api-gateway/src/slack/route.ts)
- The Slack app manifest (kept in the Slack admin panel, not in this repo)

If the bot scope list changed recently (added `im:history`, `reactions:write`, etc.), Slack invalidates the token until the admin re-approves. Skip to "Reinstall."

### C. Token leaked / actively rotated?

Signals:
- Sudden revocation without any deploy / scope change / admin action context.
- Sentry timeline shows successful `users.info` calls right up until the alert.
- Workspace admin says they rotated it after a security review.

If you suspect leak, the highest priority is *not* restoring service — it's verifying the leak is contained. Search the team's chat/issue history for any place the token might have been posted. Check the gateway's Fly secrets list (`fly secrets list -a cyggie-gateway`) to confirm only one `SLACK_BOT_TOKEN` exists.

### D. Slack-side transient (rare)

If the alert resolves itself within 15 minutes without you doing anything, treat as transient. Document the incident; no action.

## Reinstall the bot

For cases A and B (and D after triage), reinstall:

1. **Generate a fresh token.** Slack admin → Apps → Cyggie → OAuth & Permissions → "Reinstall to Workspace." Copy the new `xoxb-...` token.
2. **Update the Fly secret:**
   ```
   fly secrets set SLACK_BOT_TOKEN=xoxb-NEW-TOKEN -a cyggie-gateway
   ```
   Fly restarts the gateway automatically. Slack route comes back up within ~30s.
3. **Verify** by running `/cyggie hello` in the workspace. Should return "Hello! I'm Cyggie." within 3s.
4. **Verify user mapping recovers** by running `/cyggie search <anything>` from your own Slack account. Check Neon for a new row in `slack_user_mappings` for your Slack user id within ~10s.

## Post-incident

- If Case C (leak): document what we learned about how the token leaked. Add a CLAUDE.md or `~/.claude/skills/*` note if there's a process change.
- If Case B (scope change without admin notice): file an issue to add a CI check / pre-deploy reminder that scope changes invalidate the token.
- Reset the Sentry alert (don't leave the issue open after the token is rotated).

## Why this isn't paging-worthy by default

The bot degrades gracefully:
- Existing Slack commands still answer (the agent loop doesn't depend on `users.info`).
- Cyggie data is still returned (mapping is enrichment, not gating per plan Q7).
- Only audit attribution is lost — the `on_behalf_of_user_id` falls through to the `CYGGIE_SLACK_DEFAULT_USER_ID` stopgap.

Worth investigating same-day, not worth waking up for. Page only if:
- A Cyggie partner is actively trying to use the bot and reports it's degraded (real user pain).
- The alert correlates with another security signal (`oauth_token_reuse`, `slack_sig_failure` spikes).
- Scope-change cases that happened without admin coordination — that's a process bug worth flagging.

## Related

- [`runbooks/oauth-token-reuse.md`](oauth-token-reuse.md) — if both alerts fire together, treat as a broader security event.
- [`api-gateway/src/slack/user-mapping.ts`](../api-gateway/src/slack/user-mapping.ts) — where the alert is raised.
- Plan: [`~/.claude/plans/let-s-start-scoping-out-majestic-lecun.md`](file:///Users/sandersoncass/.claude/plans/let-s-start-scoping-out-majestic-lecun.md) — slice 7 acceptance criterion on 401 handling.
