import { shell } from 'electron'
import { createServer, type Server } from 'http'
import { URL } from 'url'
import { randomBytes, createHash } from 'crypto'
import { google } from 'googleapis'
import { getCredential, storeCredential } from '../security/credentials'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.file'
]
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GRANTED_SCOPES_KEY = 'google_granted_scopes'
const TOKEN_KEY = 'google_calendar_tokens'
const CLIENT_ID_KEY = 'google_client_id'
const CLIENT_SECRET_KEY = 'google_client_secret'

interface TokenData {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type: string
}

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

export function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> | null {
  const clientId = getCredential(CLIENT_ID_KEY)
  const clientSecret = getCredential(CLIENT_SECRET_KEY)

  if (!clientId) return null

  const client = new google.auth.OAuth2(clientId, clientSecret || undefined)

  const tokenJson = getCredential(TOKEN_KEY)
  if (tokenJson) {
    try {
      const tokens = JSON.parse(tokenJson) as TokenData
      client.setCredentials(tokens)
    } catch {
      // Invalid token data
    }
  }

  return client
}

export function isCalendarConnected(): boolean {
  const tokenJson = getCredential(TOKEN_KEY)
  if (!tokenJson) return false
  try {
    const tokens = JSON.parse(tokenJson) as TokenData
    return !!tokens.access_token
  } catch {
    return false
  }
}

export function hasDriveScope(): boolean {
  const grantedScopes = getCredential(GRANTED_SCOPES_KEY)
  return !!grantedScopes && grantedScopes.includes(DRIVE_SCOPE)
}

/**
 * Run the OAuth2 authorization flow:
 * 1. Start a loopback HTTP server on a random port
 * 2. Open the browser to Google's auth URL with PKCE
 * 3. Wait for the redirect with the auth code
 * 4. Exchange the code for tokens
 * 5. Store tokens securely
 */
export async function authorize(): Promise<void> {
  const clientId = getCredential(CLIENT_ID_KEY)
  if (!clientId) {
    throw new Error(
      'Google Client ID not configured. Add it in Settings under Calendar Integration.'
    )
  }
  const clientSecret = getCredential(CLIENT_SECRET_KEY)

  const port = await findAvailablePort()
  const redirectUri = `http://127.0.0.1:${port}`

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret || undefined, redirectUri)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    prompt: 'consent'
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

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken({
          code,
          codeVerifier
        })

        // Store tokens securely
        const tokenData: TokenData = {
          access_token: tokens.access_token || '',
          refresh_token: tokens.refresh_token || '',
          expiry_date: tokens.expiry_date || 0,
          token_type: tokens.token_type || 'Bearer'
        }
        storeCredential(TOKEN_KEY, JSON.stringify(tokenData))

        if (tokens.scope) {
          storeCredential(GRANTED_SCOPES_KEY, tokens.scope)
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body><h2>Calendar connected!</h2><p>You can close this window and return to Cyggie.</p></body></html>'
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

export function disconnect(): void {
  storeCredential(TOKEN_KEY, '')
}

export function storeGoogleClientCredentials(clientId: string, clientSecret: string): void {
  storeCredential(CLIENT_ID_KEY, clientId)
  storeCredential(CLIENT_SECRET_KEY, clientSecret)
}
