# @cyggie/api-gateway

Cloud HTTP gateway for the Cyggie mobile app (and the future web client). Fastify + zod, on top of `@cyggie/db` (drizzle / pg / Neon).

## Local dev

Prereqs: `.env.local` at the repo root with:

- `GATEWAY_DATABASE_URL` — Neon connection string for the mobile DB (separate from `web/`'s share-token DB)
- `JWT_SIGNING_SECRET` — `openssl rand -base64 48` output
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a "Web application" OAuth client in [console.cloud.google.com](https://console.cloud.google.com/apis/credentials). Authorized redirect URI: `http://127.0.0.1:8443/auth/google/callback` (dev) and the prod hostname when deployed.
- `GOOGLE_OAUTH_REDIRECT_URI` — matches the registered redirect URI exactly

Run:

```bash
npm run --workspace=@cyggie/api-gateway dev
```

Server listens on `127.0.0.1:8443`.

## Routes (Phase 0.6 baseline)

- `GET /health` — liveness
- `GET /health/ready` — readiness (pings DB)
- `POST /auth/google/start` — initiate OAuth, returns `{ authUrl, state }`
- `GET /auth/google/callback` — Google's redirect target; 302s to `cyggie://auth-callback?session=...&refresh=...`
- `POST /auth/refresh` — silent refresh; returns new access + refresh tokens
- `GET /auth/me` — current user profile (auth required)
- `POST /auth/logout` — revoke current session (auth required)
- `GET /calendar/events?from=&to=&limit=` — Google Calendar passthrough for the signed-in user

All non-2xx responses use the same envelope:

```json
{ "error": { "code": "STRING", "message": "STRING" }, "reauth_required"?: true }
```

Mobile's `lib/api/client.ts` checks `reauth_required` to fire the OAuth re-consent flow without coupling to specific routes.

## Architecture

```
   ┌────────────────────────────────────────┐
   │ Mobile (Bearer JWT)                    │
   └────────────────┬───────────────────────┘
                    │
                    ▼ HTTPS / fastify
   ┌────────────────────────────────────────┐
   │ api-gateway                            │
   │  ├─ auth plugin (verifies JWT, sets    │
   │  │   req.user, req.requireUser())      │
   │  ├─ error envelope (Zod + GatewayError)│
   │  └─ routes/{auth,health,calendar,…}    │
   └─────┬──────────────────────┬───────────┘
         │                      │
         ▼ pg (drizzle)          ▼ googleapis
   ┌──────────┐         ┌────────────────────┐
   │ Neon PG  │         │ Google Calendar API│
   │ @cyggie/db         │ (user's tokens)    │
   └──────────┘         └────────────────────┘
```

## Deferred to next sessions

- Fly.io deploy (needs `fly` CLI + account)
- Sentry / Datadog wiring (needs accounts)
- WebSocket route for live recording (M3 — see plan)
- Service extraction (Phase 0.5)
- Move OAuth `pending` state from in-memory Map to Neon table (`oauth_pending`)
- Wrap refresh_token in real KMS encryption before persisting (currently sha256 hash for storage — adequate for V1 dev, not prod)

## Runbooks

- [runbooks/recording-stuck-finalize.md](../runbooks/recording-stuck-finalize.md)
- [runbooks/sync-conflict-replay.md](../runbooks/sync-conflict-replay.md)
- [runbooks/oauth-mass-expiry.md](../runbooks/oauth-mass-expiry.md)
