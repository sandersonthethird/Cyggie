# Runbook: OAuth mass expiry

**When this fires:** all (or a large fraction of) users hit `reauth_required: true` simultaneously, because Google has invalidated their refresh tokens. Common causes:

1. Google's "6 months of inactivity" auto-expiry for refresh tokens
2. User revokes the OAuth grant in their Google Account settings (one user only)
3. Cyggie OAuth client deleted or replaced in Google Cloud Console
4. OAuth scopes changed (Google requires re-consent for new scopes)

## Detect

Datadog alert (Phase 0.6 day-1 alerts): `oauth.reauth_required` event spike — > 50% of active users in 1 hour.

Manual check via Neon:

```sql
-- How many users currently need re-auth?
SELECT count(*) FROM oauth_tokens WHERE needs_reauth = true;

-- Trend over time
SELECT date_trunc('day', updated_at) AS day, count(*)
FROM oauth_tokens WHERE needs_reauth = true
GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

## Diagnose

Check the audit log for the OAuth client used at the time:

```sql
SELECT event_type, count(*)
FROM audit_log
WHERE event_type LIKE 'oauth.%'
  AND created_at > now() - interval '24 hours'
GROUP BY 1;
```

Compare against the Google Cloud Console OAuth client at https://console.cloud.google.com/apis/credentials. Verify:
- Client ID matches `GOOGLE_CLIENT_ID` in Fly secrets
- Authorized redirect URIs include both dev `http://127.0.0.1:8443/auth/google/callback` and the deployed gateway URL
- Scopes haven't been narrowed since users last consented

## Fix

**If client was replaced or scopes changed:** users must re-auth. There is no server-side recovery — Google's refresh tokens are bound to the specific client+scope combination. Coordinate a one-time push notification: "Cyggie needs you to sign in again."

**If the issue is one user:** their `oauth_tokens.needs_reauth = true` flag will trigger the mobile app's reauth flow on their next API call. No ops action required.

**If Google API quotas are the culprit** (unlikely but possible): check https://console.cloud.google.com/iam-admin/quotas for the Cyggie project. Calendar API has generous daily quotas; we shouldn't hit them with a single firm's traffic.

## Recovery verification

After users re-sign-in, monitor:

```sql
SELECT count(*) FROM oauth_tokens WHERE needs_reauth = true AND updated_at < now() - interval '4 hours';
```

Should trend toward zero within 24-48 hours. Users who don't re-auth in that window get a follow-up notification (push or email).
