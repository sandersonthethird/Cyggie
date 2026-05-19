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

  // Optional: deferred until M3 (recording).
  DEEPGRAM_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Server bind.
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(8443),

  // Logging.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
