import { normalize, join } from 'node:path'

/**
 * Resolve `relativePath` under `rootDir` and reject any result that escapes the
 * root (path-traversal guard). Returns the normalized absolute path, or null if
 * it would escape. Shared by the asset:// and cyggie-attachment:// protocol
 * handlers so the guard lives in exactly one place.
 */
export function resolveUnder(rootDir: string, relativePath: string): string | null {
  const allowed = normalize(rootDir.endsWith('/') ? rootDir : rootDir + '/')
  const resolved = normalize(join(rootDir, relativePath))
  if (!resolved.startsWith(allowed)) return null
  return resolved
}
