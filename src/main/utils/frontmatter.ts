/**
 * Utilities for parsing YAML-style frontmatter blocks from imported note content.
 *
 * Apple Notes export format:
 *
 *   ---
 *   title: "Jack Whitten"
 *   created: "Friday, October 30, 2020 at 7:25:21 PM"
 *   modified: "Friday, October 30, 2020 at 7:27:31 PM"
 *   folder: "Art"
 *   ---
 *
 *   # Jack Whitten
 *   ...
 */

export interface ParsedFrontmatter {
  title?: string
  created?: string
  modified?: string
  folder?: string
}

export interface FrontmatterResult {
  frontmatter: ParsedFrontmatter
  body: string
}

// Matches a frontmatter key line with optional markdown heading prefix (## or #)
// e.g.  "title: \"YOGA\""  or  "## title: \"YOGA\""
const FRONTMATTER_KEY_RE = /^(?:#{1,2}\s*)?(title|created|modified|folder):\s*(.*)/i

function parseFrontmatterKeyValue(line: string): { key: string; value: string } | null {
  const m = line.match(FRONTMATTER_KEY_RE)
  if (!m) return null
  const key = m[1].toLowerCase()
  const value = m[2].trim().replace(/^["']|["']$/g, '')
  return { key, value }
}

/**
 * Parse frontmatter from a note body. Returns null if the content does not
 * start with a `---` block.
 *
 * Handles two formats produced by Apple Notes export:
 *
 *   Format A — standard YAML with closing ---:
 *     ---
 *     title: "Note title"
 *     created: "Friday, October 30, 2020 at 7:25:21 PM"
 *     modified: "Friday, October 30, 2020 at 7:27:31 PM"
 *     folder: "Art"
 *     ---
 *     Body text here
 *
 *   Format B — no closing ---, keys may have ## heading prefix, blank lines between:
 *     ---
 *
 *     ## title: "YOGA"
 *
 *     created: "Saturday, September 29, 2018 at 10:55:30 AM"
 *     modified: "Saturday, September 29, 2018 at 11:14:42 AM"
 *     folder: "Notes"
 *
 *     Body text here
 */
export function parseFrontmatter(content: string): FrontmatterResult | null {
  if (!content.startsWith('---\n')) return null

  // --- Format A: standard YAML with closing ---
  const standardMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (standardMatch) {
    const [, yamlBlock, body] = standardMatch
    const frontmatter: ParsedFrontmatter = {}
    for (const line of yamlBlock.split('\n')) {
      const kv = parseFrontmatterKeyValue(line)
      if (!kv) continue
      if (kv.key === 'title') frontmatter.title = kv.value
      else if (kv.key === 'created') frontmatter.created = kv.value
      else if (kv.key === 'modified') frontmatter.modified = kv.value
      else if (kv.key === 'folder') frontmatter.folder = kv.value
    }
    return { frontmatter, body: body.trimStart() }
  }

  // --- Format B: no closing ---, scan line-by-line
  const lines = content.split('\n')
  const frontmatter: ParsedFrontmatter = {}
  let lastFrontmatterLineIdx = 0 // index of last matched key line

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim() === '---') continue // skip blank lines / lone ---
    const kv = parseFrontmatterKeyValue(line)
    if (kv) {
      if (kv.key === 'title') frontmatter.title = kv.value
      else if (kv.key === 'created') frontmatter.created = kv.value
      else if (kv.key === 'modified') frontmatter.modified = kv.value
      else if (kv.key === 'folder') frontmatter.folder = kv.value
      lastFrontmatterLineIdx = i
    } else {
      // Non-blank, non-frontmatter line = start of actual body
      break
    }
  }

  if (lastFrontmatterLineIdx === 0) return null // no keys found

  const body = lines.slice(lastFrontmatterLineIdx + 1).join('\n').trimStart()
  return { frontmatter, body }
}

/**
 * Parse an Apple Notes date string to an ISO 8601 string.
 *
 * Input:  "Friday, October 30, 2020 at 7:25:21 PM"
 * Output: "2020-10-30T23:25:21.000Z" (exact value depends on local timezone)
 *
 * Returns null if the string cannot be parsed.
 */
export function parseAppleNotesDate(str: string): string | null {
  if (!str) return null

  // Strip "Weekday, " prefix and replace " at " separator
  const normalized = str
    .replace(/^\w+,\s*/, '')  // "Friday, " → ""
    .replace(/\s+at\s+/, ' ') // " at " → " "

  const d = new Date(normalized)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}
