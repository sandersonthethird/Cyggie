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

  // Server bind.
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(8443),

  // Logging.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ─── External Agents V1 (MCP server) ────────────────────────────────
  // Emergency disable for the entire MCP surface (per plan feature-flag
  // section). When false, POST /mcp returns 404 cleanly without binding
  // any MCP-SDK code paths.
  CYGGIE_MCP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Dev-only bearer-token bypass for the MCP endpoint. **NOT** for prod.
  // Slice 9 (OAuth 2.0 server with node-oidc-provider) replaces this
  // with a real OAuth path. Until then, set this to a random string
  // (e.g. `openssl rand -base64 32`) in dev / staging only; leave unset
  // in prod and rely on slice 9's OAuth verification.
  //
  // Requests to POST /mcp must present `Authorization: Bearer <token>`
  // matching this value exactly. If the env var is unset, MCP requires
  // OAuth (which doesn't exist yet — so /mcp is effectively closed).
  CYGGIE_MCP_DEV_TOKEN: z.string().min(16).optional(),
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
