import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'

// Server-side Google OAuth helper. Wraps google-auth-library for the gateway's
// "Web application" OAuth client (separate from desktop's "Desktop app" client —
// per plan-ceo-review §6, redirect-URI semantics differ).
//
// Flow (per plan-eng-review §1):
//   1. POST /auth/google/start
//      → generate { state, code_verifier, code_challenge, device_id }
//      → store in oauth_pending (TTL 5min) keyed by state
//      → return { authUrl, state }
//
//   2. Mobile opens authUrl. User consents. Google redirects to:
//      GET /auth/google/callback?code=...&state=...
//
//   3. Gateway:
//      a. Look up state → get code_verifier + device_id
//      b. Exchange code for tokens (access + refresh + id_token)
//      c. Decode id_token to get sub, email, name, picture
//      d. Upsert users row (look up by google_sub)
//      e. Create sessions row (refresh_token_hash, device_id)
//      f. Store Google tokens in oauth_tokens (refresh_token KMS-encrypted)
//      g. Mint our own access JWT
//      h. 302 redirect to cyggie://auth-callback?session=<jwt>&refresh=<refresh>

export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
] as const

export function createOAuthClient(opts: {
  clientId: string
  clientSecret: string
  redirectUri: string
}): OAuth2Client {
  return new google.auth.OAuth2({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    redirectUri: opts.redirectUri,
  })
}

/**
 * Build the consent URL the user agent visits. PKCE-enabled — the code_challenge
 * is sent now, the verifier is held server-side until the callback exchange.
 *
 * `loginHint`: when set, passed to Google as `login_hint` so the consent screen
 * pre-selects that Google account. Used by the mobile calendar "Reconnect Google"
 * flow to steer the user back to the account they're already signed in as. Not
 * a security boundary — Google may ignore it, and the user can still pick a
 * different account; the post-callback userId check is the real defense.
 */
export function buildAuthUrl(opts: {
  client: OAuth2Client
  state: string
  codeChallenge: string
  loginHint?: string
}): string {
  return opts.client.generateAuthUrl({
    access_type: 'offline', // returns refresh_token
    prompt: 'consent', // force refresh_token return (Google's stricter "consent" flow)
    scope: [...GOOGLE_OAUTH_SCOPES],
    state: opts.state,
    code_challenge: opts.codeChallenge,
    // @ts-expect-error — google-auth-library's CodeChallengeMethod is an enum but
    // the string 'S256' is the correct value per RFC 7636. Matches desktop's usage.
    code_challenge_method: 'S256',
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    // V1 narrows to Calendar-only consent (decision 2026-05-18 per
    // ~/.claude/plans/claude-code-prompt-jolly-eagle.md "Cloud-direct vs desktop-
    // mediated"). The desktop OAuth client retains its own broader Gmail + Drive
    // grant via a separate client_id; the gateway only asks for what V1 actually
    // uses, so first-time customers see a minimal consent screen.
    //
    // When the "Cloud-side Gmail + Drive services" backlog item ships (post-V1,
    // tracked in TODOS.md P1 section), this flips back to `true` OR the gateway
    // adds an incremental-authorization prompt at the moment Gmail/Drive features
    // first activate.
    include_granted_scopes: false,
  })
}

export interface GoogleTokens {
  accessToken: string
  refreshToken: string | null
  expiryDate: Date | null
  scope: string
  idToken: string
}

/** Exchange the authorization code (with PKCE verifier) for tokens. */
export async function exchangeCodeForTokens(opts: {
  client: OAuth2Client
  code: string
  codeVerifier: string
}): Promise<GoogleTokens> {
  const { tokens } = await opts.client.getToken({
    code: opts.code,
    codeVerifier: opts.codeVerifier,
  })
  if (!tokens.access_token || !tokens.id_token) {
    throw new Error('Google returned no access_token or id_token')
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date != null ? new Date(tokens.expiry_date) : null,
    scope: tokens.scope ?? '',
    idToken: tokens.id_token,
  }
}

export interface GoogleIdentity {
  googleSub: string
  email: string
  emailVerified: boolean
  name: string | undefined
  picture: string | undefined
}

/**
 * Decode the id_token. We trust it because we just exchanged a one-time code at
 * Google's token endpoint — Google's TLS chain authenticated the id_token to us.
 * For replay protection we could also verify the signature locally; jose can do
 * that against the JWKS at https://www.googleapis.com/oauth2/v3/certs. Deferring
 * that until we have a real security review.
 */
export async function fetchGoogleIdentity(opts: {
  client: OAuth2Client
  idToken: string
  expectedAudience: string
}): Promise<GoogleIdentity> {
  const ticket = await opts.client.verifyIdToken({
    idToken: opts.idToken,
    audience: opts.expectedAudience,
  })
  const payload = ticket.getPayload()
  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Google id_token missing sub or email')
  }
  return {
    googleSub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
  }
}
