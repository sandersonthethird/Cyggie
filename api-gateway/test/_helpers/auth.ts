import { SignJWT } from 'jose'
import { createSecretKey } from 'node:crypto'

// Mint a JWT with the same shape the OAuth server issues (HS256, aud
// 'cyggie-mcp', sub + scope + firm_id claims). The MCP route verifies with the
// same secret, so this token is indistinguishable from one issued by
// /oauth/token end-to-end — letting structural + per-tool tests skip the full
// browser-driven authorize/consent round-trip.
//
// Extracted from mcp-smoke.test.ts (Issue 5A) so the OAuth + per-tool suites
// share one minting path.
export async function mintTestToken(
  signingSecret: string,
  opts: {
    sub?: string
    scope?: string
    firmId?: string | null
    expSeconds?: number
  } = {},
): Promise<string> {
  const key = createSecretKey(Buffer.from(signingSecret, 'utf-8'))
  const now = Math.floor(Date.now() / 1000)
  const expSeconds = opts.expSeconds ?? 15 * 60
  return new SignJWT({
    scope: opts.scope ?? 'cyggie:read cyggie:ask',
    firm_id: opts.firmId === undefined ? 'test-firm' : opts.firmId,
    client_id: 'test-client',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub ?? 'test-user')
    .setIssuer('http://127.0.0.1:8443/oauth')
    .setAudience('cyggie-mcp')
    .setIssuedAt(now)
    .setExpirationTime(now + expSeconds)
    .sign(key)
}
