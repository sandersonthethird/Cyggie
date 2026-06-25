import { z } from 'zod'

// Gateway environment contract. Fail-fast at boot if anything required is missing.
//
// In production (Fly.io), all of these come from `fly secrets set`. In dev, they
// come from .env.local at the repo root (loaded via `tsx --env-file=...`).
const EnvSchema = z.object({
  // Required: cloud Postgres connection.
  GATEWAY_DATABASE_URL: z.string().url(),

  // Required: server-side JWT signing key. 32+ bytes of random data.
  // Generate with: openssl rand -base64 32
  JWT_SIGNING_SECRET: z.string().min(32),

  // Required: AES-256-GCM key for encrypting Google OAuth refresh tokens at
  // rest (oauth_tokens.refresh_token_encrypted). Must decode to exactly 32
  // bytes — generate with: openssl rand -base64 32. Lives only in Fly secrets,
  // never in the DB, so a Neon leak alone can't decrypt stored refresh tokens.
  // See auth/token-crypto.ts. Loud min() here; exact byte-length is enforced
  // in loadKey() at use.
  GOOGLE_TOKEN_ENC_KEY: z.string().min(32),

  // Required: Google OAuth client (Web application type — not the desktop client).
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Where Google redirects after consent. In dev: http://127.0.0.1:8443/auth/google/callback
  // In prod: https://gateway.cyggie.app/auth/google/callback
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),

  // Where the gateway redirects the user-agent after issuing a JWT. Universal-link
  // scheme the mobile app catches. cyggie://auth-callback?session=<jwt>
  MOBILE_DEEP_LINK_BASE: z.string().default('cyggie://auth-callback'),

  // Same as MOBILE_DEEP_LINK_BASE but for the desktop SyncAgent's sign-in flow.
  // Selected via the redirect_target query param on POST /auth/google/start
  // ('mobile' | 'desktop'). Desktop registers cyggie-desktop:// via
  // app.setAsDefaultProtocolClient; macOS LaunchServices hands the URL to
  // Electron's open-url event after the gateway 302s here.
  DESKTOP_DEEP_LINK_BASE: z.string().default('cyggie-desktop://auth-callback'),

  // Optional: deferred until production deploy.
  SENTRY_DSN: z.string().optional(),
  DATADOG_API_KEY: z.string().optional(),

  // T32 PR-B (2026-05-23): per-user keys via user_credentials only. The env
  // var is no longer read by any code path — resolveDeepgramKey returns null
  // if the user has no row, and callers (transcribe-job) fail with
  // deepgram_key_missing + Sentry alert. Kept optional in the schema for one
  // release as a no-op safety belt; will be removed entirely in a follow-up.
  DEEPGRAM_API_KEY: z.string().optional(),
  // Required as of M3: shared secret included in the Deepgram batch-callback URL
  // (https://gateway/recordings/deepgram-webhook?secret=...). The webhook handler
  // constant-time compares against this before persisting transcript / firing
  // push. Without it the public webhook URL is a forgery vector. Generate with:
  //   openssl rand -base64 32
  DEEPGRAM_WEBHOOK_SECRET: z.string().min(16),

  // Optional: deferred until LLM features come online.
  ANTHROPIC_API_KEY: z.string().optional(),

  // APNs push (M3). Optional so the gateway boots without an Apple Developer
  // Program seat — if any of these is missing, the apns module logs and no-ops
  // on send, mobile falls back to polling. All required together once Apple
  // signs the auth key.
  //
  //   APNS_KEY_ID         — 10-char Key ID from the .p8 download
  //   APNS_TEAM_ID        — 10-char Team ID from the Apple Developer account
  //   APNS_KEY_P8         — the .p8 file contents (multi-line PEM); paste into
  //                          `fly secrets set APNS_KEY_P8="$(cat AuthKey_*.p8)"`
  //   APNS_BUNDLE_ID      — e.g. com.cyggie.app
  //   APNS_ENV            — 'sandbox' for dev / TestFlight, 'production' for App Store
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY_P8: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Recording quotas (M3). Per-user, monthly.
  RECORDING_QUOTA_MONTHLY_MINUTES: z.coerce.number().int().positive().default(600),
  // Hard cap on a single uploaded audio file. 200 MB ≈ 8 hours of 16 kHz mono AAC.
  RECORDING_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),

  // ─── Note/Memo attachments — S3-compatible object storage ───────────────
  // Inline images + PDF attachments in the desktop note/memo editor. The BYTES
  // live in object storage; only small metadata rows sync via the outbox. The
  // gateway never holds the binary — it mints short-TTL, user-scoped,
  // content-type-constrained presigned URLs and the desktop PUTs/GETs directly
  // (Apple-Notes/CloudKit-style direct-to-blob).
  //
  // PRIMARY: Fly Tigris (`flyctl storage create`) sets these AWS-standard vars
  // automatically. FALLBACK: the R2_* equivalents (Cloudflare R2). Both are S3
  // v4 compatible — same SDK. All optional so the gateway boots without storage
  // (parity with APNs/Slack); the /attachments routes FAIL CLOSED with a clear
  // operator error when unconfigured. See attachment-storage.ts.
  AWS_ENDPOINT_URL_S3: z.string().url().optional(), // https://fly.storage.tigris.dev
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(), // 'auto' for Tigris/R2
  BUCKET_NAME: z.string().min(1).optional(),
  // Fallback: Cloudflare R2 names (unused when the Tigris vars above are set).
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ENDPOINT: z.string().url().optional(),
  // Hard cap on a single attachment upload. 25 MB — generous for a pitch
  // deck PDF or a full-res screenshot, far below RECORDING_MAX_UPLOAD_BYTES.
  // Enforced in the presign route (authoritative) AND desktop-side (fast fail).
  ATTACHMENT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // TTL on a minted presigned URL. 5 minutes — long enough to upload a 25 MB
  // file on a slow link, short enough that a leaked/logged URL is low-value.
  ATTACHMENT_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Server bind.
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(8443),

  // Logging.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ─── External Agents V1 (MCP server + OAuth) ────────────────────────
  // Emergency disable for the entire MCP surface (per plan feature-flag
  // section). When false, POST /mcp returns 404 cleanly without binding
  // any MCP-SDK code paths.
  CYGGIE_MCP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Public base URL of the gateway (no trailing slash). The OAuth server
  // uses this to construct absolute URLs (issuer, redirect callbacks,
  // metadata endpoints). In dev: http://127.0.0.1:8443. In prod:
  // https://cyggie-gateway.fly.dev. Falls back to HOST:PORT derived
  // value if unset, which works for local dev but not behind a proxy.
  CYGGIE_PUBLIC_BASE_URL: z.string().url().optional(),

  // ─── Slice 1 — Slack bot scaffold ───────────────────────────────────
  // Emergency disable for the Slack route (per plan feature-flag
  // section). When false, POST /slack/events returns 404 cleanly
  // without binding any Slack code paths.
  CYGGIE_SLACK_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Slack signing secret used to verify the HMAC-SHA256 signature on
  // every incoming /slack/events request (per plan decision-log #18).
  // Generated in Settings → Basic Information of the Slack app.
  // Optional in env so the gateway boots without it; the slack route
  // fails-closed (every request 401s) until set.
  SLACK_SIGNING_SECRET: z.string().min(16).optional(),

  // Slack bot OAuth token (xoxb-…). Used to call the Slack Web API:
  // chat.postMessage for replies, reactions.add for the loading-emoji
  // UX (slice 5), users.info for lazy Slack→Cyggie mapping (slice 7).
  // Optional — slice 1 fail-closes when missing, just like the signing
  // secret.
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-/).optional(),

  // Interim Slack → Cyggie user binding for slices 2–6 (search + NL Q&A
  // + thread continuity). Slice 7 replaces this with lazy email-based
  // mapping via `slack_user_mappings` + Slack's users.info API. Until
  // then, every Slack request acts as this Cyggie user — fine for the
  // single-firm beta where there's one operator (Sandy).
  //
  // If unset, search / NL queries return a clear "Cyggie not yet
  // linked" message to the Slack user.
  CYGGIE_SLACK_DEFAULT_USER_ID: z.string().min(1).optional(),

  // ─── Slice 10 — cyggie_execute_sql tool ─────────────────────────────
  // Gates the MCP `cyggie_execute_sql` tool. Default false in prod;
  // dev override via .env.local. Even when true, requests must
  // additionally carry the `cyggie:sql` scope on the OAuth access
  // token — flag toggles tool availability; scope gates per-caller
  // authorization.
  CYGGIE_MCP_SQL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Neon connection string for the dedicated read-only Postgres role.
  // SEPARATE from GATEWAY_DATABASE_URL — must be a different role with
  // only SELECT grants on the allowlisted CRM tables (companies,
  // contacts, meetings, notes, link tables) and NO access to users,
  // sessions, oauth_*, user_credentials, firms, slack_user_mappings,
  // mcp_audit. The Postgres role itself is the load-bearing security
  // boundary; this URL just connects to it. See
  // api-gateway/src/db/readonly-pool.ts for the GRANT script.
  //
  // Optional: must be set when CYGGIE_MCP_SQL_ENABLED=true. If the flag
  // is on and this URL is missing, the gateway boots successfully but
  // every cyggie_execute_sql call returns TOOL_DISABLED with a clear
  // operator message.
  NEON_READONLY_URL: z.string().url().optional(),
})

export type GatewayEnv = z.infer<typeof EnvSchema>

export function loadEnv(): GatewayEnv {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Gateway environment validation failed:')
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`)
    }
    throw new Error('Invalid gateway environment')
  }
  return parsed.data
}
