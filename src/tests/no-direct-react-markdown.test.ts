import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * Mechanically prevents regression of the "always use SafeMarkdown" rule.
 *
 * Direct imports of `react-markdown` are forbidden outside of
 * `SafeMarkdown.tsx` because SafeMarkdown is the single entry point that
 * bakes in `rehype-sanitize`. Bypassing it would silently re-open the
 * XSS surface this PR closed.
 *
 * If this test fails, swap the offending `<ReactMarkdown>` for
 * `<SafeMarkdown>` (from `renderer/components/SafeMarkdown`).
 */

const RENDERER_ROOT = join(__dirname, '..', 'renderer')
const ALLOWED_RELATIVE = join('components', 'SafeMarkdown.tsx')

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
  return files
}

describe('no direct react-markdown imports outside SafeMarkdown', () => {
  it('only SafeMarkdown.tsx imports from "react-markdown"', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER_ROOT)) {
      const rel = relative(RENDERER_ROOT, file)
      if (rel === ALLOWED_RELATIVE) continue
      const src = readFileSync(file, 'utf8')
      if (/from ['"]react-markdown['"]/.test(src)) {
        offenders.push(rel)
      }
    }
    expect(offenders, 'use SafeMarkdown instead — see src/renderer/components/SafeMarkdown.tsx').toEqual([])
  })
})
