/**
 * import-partner-sync.ts
 *
 * One-time script: imports a Google Docs partner sync HTML export into the
 * partner_meeting_digests + partner_meeting_items tables.
 *
 * Usage:
 *   npx tsx src/scripts/import-partner-sync.ts [path/to/PartnerMeetingAgenda.html]
 *
 * Defaults to: ~/Apps/Cyggie/import/partner-doc/PartnerMeetingAgenda.html
 * DB:          ~/Documents/MeetingIntelligence/echovault.db
 *
 * What it does:
 *   1. Backs up the DB (copies echovault.db → echovault.db.import-backup-TIMESTAMP)
 *   2. Deletes all existing partner_meeting_items and partner_meeting_digests rows
 *   3. Parses all "Week of X" sections from the HTML
 *   4. For each week:
 *        - Creates a digest (archived, except the most recent = active)
 *        - Maps sections to DigestSection values (see SECTION_MAP below)
 *        - Company sections: level-0 bullets = company name (fuzzy-matched to CRM),
 *          sub-bullets (level 1+) joined as markdown → brief
 *        - Admin sections: all text content → single admin item with section name as title
 *
 * Section mapping:
 *   "Priorities" / "Priorities:"  → priorities
 *   "New Deals"                   → new_deals
 *   "Further Work"                → existing_deals
 *   "Portfolio"                   → portfolio_updates
 *   "Passing"                     → passing
 *   everything else               → admin (Monitoring, People, LP/Fund, Biz Dev, etc.)
 *
 * Company matching:
 *   Jaro-Winkler similarity ≥ 0.88 against org_companies.canonical_name (case-insensitive).
 *   Unmatched bullets → admin item with title = bullet text.
 */

import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { jaroWinkler } from '../main/utils/jaroWinkler'

// ─── Config ───────────────────────────────────────────────────────────────────

const HTML_PATH = process.argv[2]
  ?? path.join(process.env.HOME!, 'Apps/Cyggie/import/partner-doc/PartnerMeetingAgenda.html')

const DB_PATH = path.join(process.env.HOME!, 'Documents/MeetingIntelligence/echovault.db')

const MATCH_THRESHOLD = 0.88  // Jaro-Winkler cutoff for company name matching

// ─── Section mapping ──────────────────────────────────────────────────────────

type DigestSection = 'priorities' | 'new_deals' | 'existing_deals' | 'portfolio_updates' | 'passing' | 'admin'

const COMPANY_SECTIONS = new Set<DigestSection>(['priorities', 'new_deals', 'existing_deals', 'portfolio_updates', 'passing'])

function mapSection(heading: string): DigestSection | null {
  const h = heading.toLowerCase().replace(/[:\s]+$/, '').trim()
  if (h === 'priorities') return 'priorities'
  if (h === 'new deals' || h === 'first calls') return 'new_deals'
  if (h === 'further work') return 'existing_deals'
  if (h === 'portfolio') return 'portfolio_updates'
  if (h === 'passing') return 'passing'
  // Skip boilerplate
  if (h === '(deal pipeline)' || h.startsWith('week of')) return null
  // Everything else → admin
  return 'admin'
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Convert "M/D/YY" → ISO date of the Tuesday of that calendar week (Mon–Sun). */
function toTuesdayOfWeek(dateStr: string): string {
  const parts = dateStr.trim().split('/')
  if (parts.length !== 3) throw new Error(`Unexpected date format: ${dateStr}`)
  const [m, d, yy] = parts.map(Number)
  const year = yy < 100 ? 2000 + yy : yy
  const date = new Date(year, m - 1, d)
  const day = date.getDay()  // 0=Sun, 1=Mon, 2=Tue, ...
  const daysToTuesday = (2 - day + 7) % 7
  date.setDate(date.getDate() + daysToTuesday)
  return date.toISOString().split('T')[0]
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim()
}

interface ListBlock {
  listId: string
  level: number
  items: string[]  // plain text of each <li>
}

/** Extract all Google Docs list blocks from an HTML chunk. */
function extractListBlocks(html: string): ListBlock[] {
  const UL_RE = /<ul[^>]+class="[^"]*lst-kix_([a-z0-9]+)-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/ul>/g
  const LI_RE = /<li[^>]*>([\s\S]*?)<\/li>/g
  const blocks: ListBlock[] = []
  let m: RegExpExecArray | null
  UL_RE.lastIndex = 0
  while ((m = UL_RE.exec(html)) !== null) {
    const listId = m[1]
    const level = parseInt(m[2], 10)
    const inner = m[3]
    const items: string[] = []
    let li: RegExpExecArray | null
    LI_RE.lastIndex = 0
    while ((li = LI_RE.exec(inner)) !== null) {
      const text = stripHtml(li[1]).replace(/\s+/g, ' ').trim()
      if (text) items.push(text)
    }
    if (items.length > 0) blocks.push({ listId, level, items })
  }
  return blocks
}

interface ParsedCompany {
  name: string
  brief: string  // sub-bullets joined as markdown
}

/**
 * Given list blocks from a company section, return top-level entries (level 0)
 * paired with their sub-bullet content as markdown.
 *
 * Structure:
 *   level-0 blocks → company names (one per <li>)
 *   level-1+ blocks following → sub-bullets for the preceding company
 */
function parseCompanySection(blocks: ListBlock[]): ParsedCompany[] {
  const companies: ParsedCompany[] = []

  // Group consecutive blocks by listId (same logical list)
  const runs: ListBlock[][] = []
  let currentRun: ListBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const prev = blocks[i - 1]
    if (!prev || b.listId === prev.listId) {
      currentRun.push(b)
    } else {
      runs.push(currentRun)
      currentRun = [b]
    }
  }
  if (currentRun.length > 0) runs.push(currentRun)

  for (const run of runs) {
    // Walk run blocks; each level-0 item starts a new company
    let currentCompany: ParsedCompany | null = null

    for (const block of run) {
      if (block.level === 0) {
        // Each item in a level-0 block is a separate company
        for (const name of block.items) {
          if (currentCompany) companies.push(currentCompany)
          currentCompany = { name, brief: '' }
        }
      } else if (currentCompany) {
        // Sub-bullets → append as markdown lines
        const indent = '  '.repeat(block.level - 1)
        const newLines = block.items.map(t => `${indent}- ${t}`).join('\n')
        currentCompany.brief = currentCompany.brief
          ? currentCompany.brief + '\n' + newLines
          : newLines
      }
    }
    if (currentCompany) companies.push(currentCompany)
  }

  return companies
}

/** Extract all text content from list blocks as a markdown string (for admin items). */
function parseAdminSection(blocks: ListBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    const indent = '  '.repeat(block.level)
    for (const item of block.items) {
      lines.push(`${indent}- ${item}`)
    }
  }
  return lines.join('\n')
}

interface ParsedSection {
  heading: string
  section: DigestSection
  blocks: ListBlock[]
}

interface ParsedWeek {
  dateStr: string     // raw e.g. "3/8/26"
  weekOf: string      // ISO Tuesday e.g. "2026-03-10"
  sections: ParsedSection[]
}

/** Parse the full HTML into a list of weeks, each with sections and list blocks. */
function parseHtml(html: string): ParsedWeek[] {
  // Find all "Week of X" headings (only class="c18 title" — not the repeated boilerplate c31 copies)
  const TITLE_RE = /<p[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>[\s\S]*?Week of ([^<&\n]+)/g
  const SECTION_RE = /<p[^>]+class="[^"]*\bc31\b[^"]*"[^>]*>([\s\S]*?)<\/p>/g

  const titleMatches: Array<{ dateStr: string; pos: number }> = []
  let m: RegExpExecArray | null
  TITLE_RE.lastIndex = 0
  while ((m = TITLE_RE.exec(html)) !== null) {
    titleMatches.push({ dateStr: m[1].trim(), pos: m.index })
  }

  const weeks: ParsedWeek[] = []

  for (let wi = 0; wi < titleMatches.length; wi++) {
    const { dateStr, pos } = titleMatches[wi]
    const end = wi + 1 < titleMatches.length ? titleMatches[wi + 1].pos : html.length
    const chunk = html.slice(pos, end)

    // Parse section headings within this week chunk
    const sectionStarts: Array<{ heading: string; pos: number }> = []
    SECTION_RE.lastIndex = 0
    while ((m = SECTION_RE.exec(chunk)) !== null) {
      const heading = stripHtml(m[1]).replace(/\s+/g, ' ').trim()
      if (heading) sectionStarts.push({ heading, pos: m.index })
    }

    const parsedSections: ParsedSection[] = []

    for (let si = 0; si < sectionStarts.length; si++) {
      const { heading, pos: sPos } = sectionStarts[si]
      const sEnd = si + 1 < sectionStarts.length ? sectionStarts[si + 1].pos : chunk.length
      const sChunk = chunk.slice(sPos, sEnd)

      const section = mapSection(heading)
      if (!section) continue  // skip "(Deal Pipeline)", week-of boilerplate, etc.

      const blocks = extractListBlocks(sChunk)
      if (blocks.length > 0) {
        parsedSections.push({ heading, section, blocks })
      }
    }

    let weekOf: string
    try {
      weekOf = toTuesdayOfWeek(dateStr)
    } catch {
      console.warn(`  Skipping unparseable week date: "${dateStr}"`)
      continue
    }

    weeks.push({ dateStr, weekOf, sections: parsedSections })
  }

  return weeks
}

// ─── Company matching ─────────────────────────────────────────────────────────

interface CrmCompany {
  id: string
  name: string          // canonical_name
  nameLower: string     // for matching
}

function loadCrmCompanies(db: Database.Database): CrmCompany[] {
  const rows = db.prepare(`SELECT id, canonical_name FROM org_companies`).all() as Array<{ id: string; canonical_name: string }>
  return rows.map(r => ({
    id: r.id,
    name: r.canonical_name,
    nameLower: r.canonical_name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(),
  }))
}

function matchCompany(name: string, companies: CrmCompany[]): CrmCompany | null {
  const needle = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
  let bestScore = 0
  let bestMatch: CrmCompany | null = null
  for (const c of companies) {
    const score = jaroWinkler(needle, c.nameLower)
    if (score > bestScore) {
      bestScore = score
      bestMatch = c
    }
  }
  return bestScore >= MATCH_THRESHOLD ? bestMatch : null
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(HTML_PATH)) {
    console.error(`HTML file not found: ${HTML_PATH}`)
    process.exit(1)
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`)
    process.exit(1)
  }

  // Backup DB
  const backupPath = `${DB_PATH}.import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(DB_PATH, backupPath)
  console.log(`✓ DB backed up → ${path.basename(backupPath)}`)

  const db = new Database(DB_PATH)
  const html = fs.readFileSync(HTML_PATH, 'utf8')

  console.log('Parsing HTML…')
  const weeks = parseHtml(html)
  console.log(`  Found ${weeks.length} weeks`)

  // Load CRM companies for matching
  const crmCompanies = loadCrmCompanies(db)
  console.log(`  Loaded ${crmCompanies.length} CRM companies`)

  // Delete all existing digests + items (CASCADE should handle items, but be explicit)
  db.prepare(`DELETE FROM partner_meeting_items`).run()
  db.prepare(`DELETE FROM partner_meeting_digests`).run()
  console.log('✓ Cleared existing digests and items')

  // Sort weeks oldest → newest; most recent will be 'active'
  const sorted = [...weeks].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const mostRecentWeekOf = sorted[sorted.length - 1]?.weekOf

  const now = new Date().toISOString()
  let digestsCreated = 0
  let itemsCreated = 0
  let companiesMatched = 0
  let companiesUnmatched = 0

  const insertDigest = db.prepare(
    `INSERT INTO partner_meeting_digests
       (id, week_of, status, dismissed_suggestions, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?)`
  )

  const insertCompanyItem = db.prepare(
    `INSERT INTO partner_meeting_items
       (id, digest_id, company_id, section, position, brief, is_discussed, carry_over, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(digest_id, company_id) DO UPDATE SET
       brief     = CASE
                     WHEN excluded.brief IS NOT NULL AND brief IS NOT NULL
                     THEN brief || char(10) || excluded.brief
                     ELSE COALESCE(excluded.brief, brief)
                   END,
       updated_at = excluded.updated_at`
  )

  const insertAdminItem = db.prepare(
    `INSERT INTO partner_meeting_items
       (id, digest_id, company_id, section, position, title, meeting_notes, is_discussed, carry_over, created_at, updated_at)
     VALUES (?, ?, NULL, 'admin', ?, ?, ?, 0, 0, ?, ?)`
  )

  const importAll = db.transaction(() => {
    for (const week of sorted) {
      const digestId = randomUUID()
      const status = week.weekOf === mostRecentWeekOf ? 'active' : 'archived'
      const archivedAt = status === 'archived' ? now : null

      insertDigest.run(digestId, week.weekOf, status, now, now)

      // Track position per section within this digest
      const sectionPos: Record<string, number> = {}
      const nextPos = (section: string) => {
        sectionPos[section] = (sectionPos[section] ?? 0) + 1
        return sectionPos[section]
      }

      for (const { heading, section, blocks } of week.sections) {
        if (COMPANY_SECTIONS.has(section)) {
          const companies = parseCompanySection(blocks)

          for (const company of companies) {
            const match = matchCompany(company.name, crmCompanies)

            if (match) {
              companiesMatched++
              insertCompanyItem.run(
                randomUUID(), digestId, match.id, section,
                nextPos(section), company.brief || null, now, now
              )
            } else {
              // Unmatched → admin item with company name as title, brief as content
              companiesUnmatched++
              const title = company.name
              const brief = company.brief || null
              insertAdminItem.run(
                randomUUID(), digestId, nextPos('admin'), title, brief, now, now
              )
            }
            itemsCreated++
          }
        } else {
          // Admin section: all text → single admin item
          const content = parseAdminSection(blocks)
          if (content.trim()) {
            insertAdminItem.run(
              randomUUID(), digestId, nextPos('admin'), heading, content, now, now
            )
            itemsCreated++
          }
        }
      }

      // Update archived_at separately (avoids schema changes)
      if (archivedAt) {
        db.prepare(`UPDATE partner_meeting_digests SET archived_at=? WHERE id=?`).run(archivedAt, digestId)
      }

      digestsCreated++
      console.log(`  ${status === 'active' ? '★' : '·'} ${week.weekOf} (${week.dateStr}) — ${week.sections.length} sections`)
    }
  })

  importAll()

  console.log()
  console.log(`✓ Import complete`)
  console.log(`  Digests created: ${digestsCreated}`)
  console.log(`  Items created:   ${itemsCreated}`)
  console.log(`  Companies matched to CRM: ${companiesMatched}`)
  console.log(`  Companies unmatched (→ admin): ${companiesUnmatched}`)

  db.close()
}

main()
