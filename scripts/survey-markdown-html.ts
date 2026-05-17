/**
 * survey-markdown-html.ts
 *
 * Surveys real AI-emitted markdown content in the local SQLite DB and on-disk
 * .md files to enumerate every HTML tag and attribute that downstream
 * SafeMarkdown sanitization needs to allow.
 *
 * Run with:
 *   npx tsx scripts/survey-markdown-html.ts
 *
 * Output: sorted frequency report of {tag, count} and {tag/attr, count}.
 * Drives the schema in src/renderer/lib/markdown-sanitize.ts.
 *
 * Re-run this script after any model upgrade (Claude/OpenAI) — see the TODOS.md
 * entry "Re-run markdown HTML survey after model upgrades".
 */

import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'

const DB_PATH = join(homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')
const SUMMARY_DIR = join(homedir(), 'Documents', 'MeetingIntelligence', 'summaries')
const TRANSCRIPT_DIR = join(homedir(), 'Documents', 'MeetingIntelligence', 'transcripts')
const MEMO_DIR = join(homedir(), 'Documents', 'MeetingIntelligence', 'memos')

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\s*([^>]*?)\/?>/g
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=/g

function collectContent(): string[] {
  const samples: string[] = []
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

  const push = (rows: unknown[], col: string) => {
    for (const r of rows) {
      const v = (r as Record<string, unknown>)[col]
      if (typeof v === 'string' && v.length > 0) samples.push(v)
    }
  }

  try {
    push(
      db.prepare(
        `SELECT content FROM chat_session_messages WHERE role='assistant' ORDER BY id DESC LIMIT 100`
      ).all(),
      'content'
    )
  } catch (e) {
    console.error('chat_session_messages skipped:', (e as Error).message)
  }

  try {
    push(
      db.prepare(
        `SELECT content_markdown FROM investment_memo_versions ORDER BY id DESC LIMIT 50`
      ).all(),
      'content_markdown'
    )
  } catch (e) {
    console.error('investment_memo_versions skipped:', (e as Error).message)
  }

  try {
    push(
      db.prepare(
        `SELECT content FROM notes WHERE import_source IS NULL ORDER BY id DESC LIMIT 100`
      ).all(),
      'content'
    )
  } catch (e) {
    console.error('notes skipped:', (e as Error).message)
  }

  db.close()

  for (const dir of [SUMMARY_DIR, TRANSCRIPT_DIR, MEMO_DIR]) {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
      for (const f of files.slice(0, 50)) {
        const p = join(dir, f)
        if (statSync(p).isFile()) samples.push(readFileSync(p, 'utf8'))
      }
    } catch {
      // dir doesn't exist or is empty — skip
    }
  }

  return samples
}

function survey(samples: string[]) {
  const tagCounts = new Map<string, number>()
  const tagAttrCounts = new Map<string, number>()

  for (const text of samples) {
    TAG_RE.lastIndex = 0
    let m
    while ((m = TAG_RE.exec(text)) !== null) {
      const tag = m[1].toLowerCase()
      const isCloseTag = text[m.index + 1] === '/'
      const canonical = isCloseTag ? `/${tag}` : tag
      tagCounts.set(canonical, (tagCounts.get(canonical) || 0) + 1)

      if (!isCloseTag) {
        ATTR_RE.lastIndex = 0
        let am
        while ((am = ATTR_RE.exec(m[2])) !== null) {
          const attr = am[1].toLowerCase()
          const key = `${tag}/${attr}`
          tagAttrCounts.set(key, (tagAttrCounts.get(key) || 0) + 1)
        }
      }
    }
  }

  return { tagCounts, tagAttrCounts }
}

function main() {
  console.log(`Reading samples from ${DB_PATH} ...`)
  const samples = collectContent()
  console.log(`Collected ${samples.length} text samples\n`)

  const { tagCounts, tagAttrCounts } = survey(samples)

  console.log('=== Tags found (frequency desc) ===')
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag.padEnd(24)} ${count}`)
  }

  console.log('\n=== Attributes by tag (sorted) ===')
  for (const [key, count] of [...tagAttrCounts.entries()].sort()) {
    console.log(`  ${key.padEnd(32)} ${count}`)
  }
}

main()
