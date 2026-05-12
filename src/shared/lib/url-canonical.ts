/**
 * Canonical form for URL comparison. Two URLs that resolve to the same
 * resource should canonicalize to the same string.
 *
 *   - Lowercase host
 *   - Strip default ports (:80 for http, :443 for https)
 *   - Strip trailing slash from path (except root "/")
 *   - Preserve case-sensitive path + query + fragment
 *
 * Returns null if the URL is malformed or uses a non-http(s) protocol.
 *
 * Lives in shared/ because the producer agent's web_fetch allowlist (main),
 * the citation preprocessor (renderer), and the section roster tests (Vitest)
 * all need byte-identical canonicalization.
 */
export function canonicalizeUrl(input: string): string | null {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hostname = u.hostname.toLowerCase()
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = ''
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '')
  }
  return u.toString()
}
