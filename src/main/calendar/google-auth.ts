import { shell } from 'electron'
import { createServer, type Server } from 'http'
import { URL } from 'url'
import { randomBytes, createHash } from 'crypto'
import { google } from 'googleapis'
import { getCredential, storeCredential } from '../security/credentials'

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.file'
]
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const LEGACY_GRANTED_SCOPES_KEY = 'google_granted_scopes'
const CALENDAR_GRANTED_SCOPES_KEY = 'google_calendar_granted_scopes'
const GMAIL_GRANTED_SCOPES_KEY = 'google_gmail_granted_scopes'
const CALENDAR_TOKEN_KEY = 'google_calendar_tokens'
const GMAIL_TOKEN_KEY = 'google_gmail_tokens'
const CLIENT_ID_KEY = 'google_client_id'
const CLIENT_SECRET_KEY = 'google_client_secret'

interface TokenData {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type: string
}

interface OAuthFlowConfig {
  scopes: string[]
  tokenKey: string
  grantedScopesKey: string
  successTitle: string
}

let legacyScopesMigrated = false

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Could not find available port'))
      }
    })
    server.on('error', reject)
  })
}

function parseScopeString(scopes: string | null): string[] {
  if (!scopes) return []
  return scopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
}

function parseTokenData(tokenJson: string | null): TokenData | null {
  if (!tokenJson) return null
  try {
    return JSON.parse(tokenJson) as TokenData
  } catch {
    return null
  }
}

function hasStoredToken(tokenKey: string): boolean {
  const tokens = parseTokenData(getCredential(tokenKey))
  if (!tokens) return false
  return Boolean(tokens.access_token || tokens.refresh_token)
}

function ensureLegacyScopeMigration(): void {
  if (legacyScopesMigrated) return
  legacyScopesMigrated = true

  const legacyScopeRaw = getCredential(LEGACY_GRANTED_SCOPES_KEY)
  if (!legacyScopeRaw) return

  const legacyScopes = parseScopeString(legacyScopeRaw)
  if (legacyScopes.length === 0) {
    storeCredential(LEGACY_GRANTED_SCOPES_KEY, '')
    return
  }

  if (!getCredential(CALENDAR_GRANTED_SCOPES_KEY)) {
    const calendarScopes = legacyScopes.filter(
      (scope) => scope === CALENDAR_READONLY_SCOPE || scope === DRIVE_SCOPE
    )
    if (calendarScopes.length > 0) {
      storeCredential(CALENDAR_GRANTED_SCOPES_KEY, calendarScopes.join(' '))
    }
  }

  if (!getCredential(GMAIL_GRANTED_SCOPES_KEY) && legacyScopes.includes(GMAIL_READONLY_SCOPE)) {
    storeCredential(GMAIL_GRANTED_SCOPES_KEY, GMAIL_READONLY_SCOPE)
  }

  storeCredential(LEGACY_GRANTED_SCOPES_KEY, '')
}

function createOAuth2Client(tokenKey: string): InstanceType<typeof google.auth.OAuth2> | null {
  const clientId = getCredential(CLIENT_ID_KEY)
  const clientSecret = getCredential(CLIENT_SECRET_KEY)

  if (!clientId) return null

  const client = new google.auth.OAuth2(clientId, clientSecret || undefined)

  const tokens = parseTokenData(getCredential(tokenKey))
  if (tokens) {
    client.setCredentials(tokens)
  }

  return client
}

function getTokenBackedOAuth2Client(tokenKey: string): InstanceType<typeof google.auth.OAuth2> | null {
  if (!hasStoredToken(tokenKey)) return null
  return createOAuth2Client(tokenKey)
}

function getScopesForKey(scopeKey: string): string[] {
  ensureLegacyScopeMigration()
  return parseScopeString(getCredential(scopeKey))
}

function getClientIdOrThrow(): { clientId: string; clientSecret: string } {
  const clientId = getCredential(CLIENT_ID_KEY)
  if (!clientId) {
    throw new Error('Google Client ID not configured. Add it in Settings under Google integrations.')
  }
  const clientSecret = getCredential(CLIENT_SECRET_KEY) || ''
  return { clientId, clientSecret }
}

async function runAuthorizationFlow(config: OAuthFlowConfig): Promise<void> {
  const { scopes, tokenKey, grantedScopesKey, successTitle } = config

  const { clientId, clientSecret } = getClientIdOrThrow()

  const port = await findAvailablePort()
  const redirectUri = `http://127.0.0.1:${port}`

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret || undefined, redirectUri)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    include_granted_scopes: false,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    prompt: 'consent select_account'
  })

  return new Promise<void>((resolve, reject) => {
    let server: Server | null = null
    const timeout = setTimeout(() => {
      server?.close()
      reject(new Error('OAuth flow timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>'
          )
          clearTimeout(timeout)
          server?.close()
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>No authorization code received.</p></body></html>')
          return
        }

        const { tokens } = await oauth2Client.getToken({
          code,
          codeVerifier
        })

        const tokenData: TokenData = {
          access_token: tokens.access_token || '',
          refresh_token: tokens.refresh_token || '',
          expiry_date: tokens.expiry_date || 0,
          token_type: tokens.token_type || 'Bearer'
        }
        storeCredential(tokenKey, JSON.stringify(tokenData))

        if (tokens.scope) {
          storeCredential(grantedScopesKey, tokens.scope)
        } else {
          storeCredential(grantedScopesKey, scopes.join(' '))
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body><h2>${successTitle}</h2><p>You can close this window and return to Cyggie.</p></body></html>`
        )

        clearTimeout(timeout)
        server?.close()
        resolve()
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Error</h2><p>Something went wrong.</p></body></html>')
        clearTimeout(timeout)
        server?.close()
        reject(err)
      }
    })

    server.listen(port, '127.0.0.1', () => {
      shell.openExternal(authUrl)
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

export function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> | null {
  return getTokenBackedOAuth2Client(CALENDAR_TOKEN_KEY)
}

export function getGmailOAuth2Client(): InstanceType<typeof google.auth.OAuth2> | null {
  const gmailClient = getTokenBackedOAuth2Client(GMAIL_TOKEN_KEY)
  if (gmailClient) return gmailClient

  // Backward compatibility: older installs stored Gmail grants on the calendar token.
  if (hasStoredToken(CALENDAR_TOKEN_KEY) && hasGmailScope()) {
    return getTokenBackedOAuth2Client(CALENDAR_TOKEN_KEY)
  }

  return null
}

export function isCalendarConnected(): boolean {
  return hasStoredToken(CALENDAR_TOKEN_KEY)
}

export function isGmailConnected(): boolean {
  if (hasStoredToken(GMAIL_TOKEN_KEY)) return true
  return hasStoredToken(CALENDAR_TOKEN_KEY) && hasGmailScope()
}

export function hasDriveScope(): boolean {
  return getCalendarGrantedScopes().includes(DRIVE_SCOPE)
}

export function hasGmailScope(): boolean {
  return getGmailGrantedScopes().includes(GMAIL_READONLY_SCOPE)
}

export function getCalendarGrantedScopes(): string[] {
  return getScopesForKey(CALENDAR_GRANTED_SCOPES_KEY)
}

export function getGmailGrantedScopes(): string[] {
  return getScopesForKey(GMAIL_GRANTED_SCOPES_KEY)
}

// Backward-compatible alias for existing callers that still expect calendar scopes.
export function getGrantedScopes(): string[] {
  return getCalendarGrantedScopes()
}

export async function authorize(): Promise<void> {
  await runAuthorizationFlow({
    scopes: CALENDAR_SCOPES,
    tokenKey: CALENDAR_TOKEN_KEY,
    grantedScopesKey: CALENDAR_GRANTED_SCOPES_KEY,
    successTitle: 'Calendar connected!'
  })
}

export async function authorizeGmail(): Promise<void> {
  await runAuthorizationFlow({
    scopes: GMAIL_SCOPES,
    tokenKey: GMAIL_TOKEN_KEY,
    grantedScopesKey: GMAIL_GRANTED_SCOPES_KEY,
    successTitle: 'Gmail connected!'
  })
}

export function disconnect(): void {
  ensureLegacyScopeMigration()
  storeCredential(CALENDAR_TOKEN_KEY, '')
  storeCredential(CALENDAR_GRANTED_SCOPES_KEY, '')
}

export function disconnectGmail(): void {
  ensureLegacyScopeMigration()
  storeCredential(GMAIL_TOKEN_KEY, '')
  storeCredential(GMAIL_GRANTED_SCOPES_KEY, '')
}

export function storeGoogleClientCredentials(clientId: string, clientSecret: string): void {
  storeCredential(CLIENT_ID_KEY, clientId)
  storeCredential(CLIENT_SECRET_KEY, clientSecret)
}
