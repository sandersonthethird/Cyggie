#!/usr/bin/env node

/**
 * import-partner-doc.js — One-time ingest of the historical partner sync Google Doc.
 *
 * The Google Doc has weekly meeting notes broken up by week, each week separated by
 * a "date page" that contains only the meeting date. Within each week, content is
 * organized by named sections (Priorities, Further Work, Admin, Monitoring, etc.),
 * and within each section, companies are identified by a bold name followed by bullet
 * points of discussion notes.
 *
 * Processing pipeline:
 *
 *   HTML file on disk
 *         │
 *         ▼
 *   [1] Load raw HTML
 *         │
 *         ▼
 *   [2] jsdom pre-processing (single pass)
 *       ├─ <span style="font-weight:700"> → <strong>   (Google Docs bold normalization)
 *       └─ <div style="page-break-before:always"> → <hr>  (page break normalization)
 *         │
 *         ▼
 *   [3] turndown → single markdown string
 *         │
 *         ▼
 *   [4] Walk markdown line-by-line → weeks → sections → company blocks
 *       ├─ `---` markers → week boundaries
 *       ├─ Date-only lines → weekOf (compute Tuesday of that week)
 *       ├─ Known section headers (**bold** or ## heading) → currentSection
 *       └─ Bold-only lines (not section headers) → company name
 *         │
 *         ▼
 *   [5] Match companies (exact → compact → token/Levenshtein fuzzy)
 *       └─ Create missing companies (include_in_companies_view=0 — hidden until reviewed)
 *         │
 *         ▼
 *   [6] Scan notes for contact name mentions
 *       └─ Token pre-filter → Jaro-Winkler ≥ 0.92 → insert [Name](/#/contact/{id}) links
 *         │
 *         ▼
 *   [7] For each week: idempotency check → BEGIN TRANSACTION → INSERT digest + items → COMMIT
 *       └─ ROLLBACK on error → log + skip week + continue
 *
 * Usage:
 *   node scripts/import-partner-doc.js import/partner-doc/partner-sync.html [options]
 *
 * Options:
 *   --db <path>      SQLite DB path (default: ~/Documents/MeetingIntelligence/echovault.db)
 *   --dry-run        Parse + match + print per-company decisions — no DB writes
 *   --no-backup      Skip DB backup before write
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const Database = require('better-sqlite3')
const { JSDOM } = require('jsdom')
const TurndownService = require('turndown')

// ─── CLI ──────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')

function printUsage() {
  console.log('Usage: node scripts/import-partner-doc.js <html_path> [options]')
  console.log('')
  console.log('Options:')
  console.log('  --db <path>     SQLite DB path')
  console.log(`                  (default: ${DEFAULT_DB_PATH})`)
  console.log('  --dry-run       Parse + match + print, no DB writes')
  console.log('  --no-backup     Skip DB backup before write')
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const options = {
    htmlPath: '',
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
    backup: true,
  }

  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === '--help' || token === '-h') {
      printUsage()
      process.exit(0)
    }
    if (token === '--db') {
      const next = args[i + 1]
      if (!next) throw new Error('--db requires a path')
      options.dbPath = next
      i += 2
      continue
    }
    if (token === '--dry-run') {
      options.dryRun = true
      i++
      continue
    }
    if (token === '--no-backup') {
      options.backup = false
      i++
      continue
    }
    if (!options.htmlPath) {
      options.htmlPath = token
      i++
      continue
    }
    throw new Error(`Unexpected argument: ${token}`)
  }

  if (!options.htmlPath) {
    printUsage()
    process.exit(1)
  }

  return options
}

// ─── STRING UTILITIES ─────────────────────────────────────────────────────────
// Copied from scripts/import-memos-from-google-docs.js — keep in sync if that changes.

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function tokenizeName(value) {
  return normalizeName(value)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
}

// ─── JARO-WINKLER ─────────────────────────────────────────────────────────────
// Inlined from src/main/utils/jaroWinkler.ts (TypeScript source — keep in sync if that changes).

function jaroWinkler(a, b) {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0)
  const aMatched = new Array(a.length).fill(false)
  const bMatched = new Array(b.length).fill(false)

  let matches = 0
  let transpositions = 0

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow)
    const hi = Math.min(b.length - 1, i + matchWindow)
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }

  const jaro =
    matches / a.length / 3 +
    matches / b.length / 3 +
    (matches - transpositions / 2) / matches / 3

  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}

// ─── LEVENSHTEIN ──────────────────────────────────────────────────────────────
// Adapted from scripts/import-memos-from-google-docs.js

function levenshteinDistance(a, b) {
  const m = a.length
  const n = b.length
  const dp = []
  for (let i = 0; i <= m; i++) {
    dp[i] = [i]
    for (let j = 1; j <= n; j++) dp[i][j] = i === 0 ? j : 0
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

// ─── SECTION MAPPING ──────────────────────────────────────────────────────────

/**
 * Google Doc section header (lowercase) → app DigestSection.
 * Use doc's original sections as authoritative — do NOT use determineSection() logic.
 * Historical placement > current pipeline stage.
 */
const SECTION_MAP = {
  priorities: 'priorities',
  priority: 'priorities',
  'for discussion': 'priorities',
  'to discuss': 'priorities',
  'open questions': 'priorities',
  'new deals': 'new_deals',
  'new deal': 'new_deals',
  'first calls': 'new_deals',
  'first call': 'new_deals',
  'existing deals': 'existing_deals',
  'further work': 'existing_deals',
  portfolio: 'portfolio_updates',
  'portfolio updates': 'portfolio_updates',
  'portfolio update': 'portfolio_updates',
  passing: 'passing',
  pass: 'passing',
  'all companies / pass': 'passing',
  'all companies/pass': 'passing',
  admin: 'admin',
  administrative: 'admin',
  'biz dev / admin': 'admin',
  'biz dev/admin': 'admin',
  'lp / fund v notes': 'admin',
  lps: 'admin',
  monitoring: 'other',
  people: 'other',
  tidbits: 'other',
  'investor letter ideas': 'other',
}

// Sections where items have no company link (all items are admin-type)
const ADMIN_SECTIONS = new Set(['admin'])

// App sections where depth-0 bullets represent company names.
// In all OTHER sections (priorities, admin, other), depth-0 bullets are just notes —
// they could be action items, person names, agenda items, etc.
const COMPANY_SECTIONS = new Set(['new_deals', 'existing_deals', 'portfolio_updates', 'passing'])

// App sections where we try to match company names from bullets but DON'T create new
// company records for unmatched items — only link to existing companies.
// This allows priorities items like "Loman" to link to the CRM without creating
// junk records for action items like "Taxes", "Fundraising", "Website".
const MATCH_ONLY_SECTIONS = new Set(['priorities'])

// Sections where items get a prefix in their notes
const NOTE_PREFIXES = {
  monitoring: '**[Monitoring]**\n\n',
}

// ─── DATE UTILITIES ───────────────────────────────────────────────────────────

const DATE_REGEX =
  /(?:week\s+of\s+)?(?:\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s.]+\d{1,2},?\s*\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b)/i

function isDateOnlyLine(line) {
  const stripped = line.trim()
  if (!stripped) return false
  return DATE_REGEX.test(stripped) && stripped.replace(DATE_REGEX, '').trim() === ''
}

function parseDate(line) {
  const match = line.match(DATE_REGEX)
  if (!match) return null
  const raw = match[0].replace(/^week\s+of\s+/i, '').trim()

  // Try MM/DD/YY or MM/DD/YYYY (avoids ambiguity with new Date() parsing)
  const mmdd = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (mmdd) {
    let year = parseInt(mmdd[3])
    if (year < 100) year += 2000  // 2-digit year: "26" → 2026
    const d = new Date(year, parseInt(mmdd[1]) - 1, parseInt(mmdd[2]), 12, 0, 0)
    if (!isNaN(d.getTime())) return d
  }

  // YYYY-MM-DD
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]), 12, 0, 0)
    if (!isNaN(d.getTime())) return d
  }

  // "Month DD, YYYY" and variants
  const d = new Date(raw + ' 12:00:00')
  if (!isNaN(d.getTime())) return d

  return null
}

/**
 * Returns the ISO date (YYYY-MM-DD) of the Tuesday on-or-before the given date.
 * Partner sync meetings are on Tuesdays, so date separator pages should typically
 * already be Tuesdays. For Wed-Sun dates, this returns the preceding Tuesday (same
 * meeting week). For Monday, returns the Monday's preceding Tuesday — edge case
 * unlikely in practice since meetings are always on Tuesdays.
 */
function tuesdayOf(date) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  while (d.getDay() !== 2) d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ─── HTML → MARKDOWN ──────────────────────────────────────────────────────────

function htmlToMarkdown(html, htmlPath) {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  // Normalize Google Docs bold spans → <strong>
  // Google Docs renders bold as <span style="font-weight:700"> rather than <strong>.
  for (const span of doc.querySelectorAll('span[style*="font-weight"]')) {
    const fw = span.style.fontWeight
    if (fw === '700' || fw === 'bold') {
      const strong = doc.createElement('strong')
      strong.innerHTML = span.innerHTML
      span.replaceWith(strong)
    }
  }

  // Normalize page breaks → <hr> so turndown produces '---' markers.
  // Google Docs uses <div style="page-break-before:always"> for page breaks.
  for (const div of doc.querySelectorAll('div[style*="page-break-before"]')) {
    div.replaceWith(doc.createElement('hr'))
  }
  for (const el of doc.querySelectorAll('[class*="page-break"]')) {
    el.replaceWith(doc.createElement('hr'))
  }

  // Convert "Week of M/D/YY" title paragraphs → <hr> + paragraph.
  // This Google Doc uses <p class="... title" id="h.xxx"> for each weekly section heading
  // rather than page-break divs. We inject an <hr> before each such heading so the
  // markdown parser can detect week boundaries via '---' markers.
  const WEEK_OF_TITLE_RE = /^week\s+of\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i
  for (const p of doc.querySelectorAll('p[id^="h."]')) {
    if (p.classList.contains('title') && WEEK_OF_TITLE_RE.test(p.textContent.trim())) {
      p.parentNode.insertBefore(doc.createElement('hr'), p)
    }
  }

  // Convert images to base64 data URIs so they render in the app.
  // Google Docs exports images as relative paths (e.g., images/image001.png) alongside the HTML.
  // Embedding as data URIs means images are stored inline in the DB and render everywhere.
  // If the image file isn't found (e.g., missing folder), remove the img to avoid broken refs.
  const htmlDir = path.dirname(htmlPath)
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:') || src.startsWith('http')) continue
    const imgPath = path.join(htmlDir, decodeURIComponent(src))
    if (fs.existsSync(imgPath)) {
      const ext = path.extname(imgPath).toLowerCase().slice(1)
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`
      const data = fs.readFileSync(imgPath)
      img.setAttribute('src', `data:${mime};base64,${data.toString('base64')}`)
    } else {
      img.remove()
    }
  }

  const td = new TurndownService({ bulletListMarker: '-', headingStyle: 'atx' })

  // Custom rule: use Google Docs depth-class (lst-kix_XXX-N) to produce indented bullets.
  // Google Docs exports nested lists as sequential flat <ul> elements with depth-in-classname
  // rather than properly nested HTML. This rule adds the correct indentation per depth level
  // so the markdown parser can distinguish company names (depth 0) from notes (depth 1+).
  td.addRule('googleDocsDepthList', {
    filter: function (node) {
      if (node.nodeName !== 'LI') return false
      const parent = node.parentNode
      return parent && Array.from(parent.classList || []).some((c) => /^lst-kix_.+-\d+$/.test(c))
    },
    replacement: function (content, node) {
      const parent = node.parentNode
      const depthClass = Array.from(parent.classList || []).find((c) => /^lst-kix_.+-\d+$/.test(c))
      const depth = depthClass ? parseInt(depthClass.match(/-(\d+)$/)[1]) : 0
      const indent = '    '.repeat(depth)
      const cleanContent = content.trim().replace(/\n{3,}/g, '\n\n')
      return '\n\n' + indent + '- ' + cleanContent
    },
  })

  return td.turndown(dom.serialize())
}

// ─── MARKDOWN PARSER ──────────────────────────────────────────────────────────

/** Strips **bold** and ## heading prefixes from a line and returns the inner text. */
function stripMarkdownWrappers(line) {
  return line
    .trim()
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^#{1,6}\s+/, '')
    .trim()
}

/**
 * Parse the full markdown into an array of week objects.
 *
 * This Google Doc uses a specific structure:
 *   - Section headers: plain text paragraphs matching known section names (e.g. "New Deals", "Priorities:")
 *   - Company names: depth-0 bullet items (no leading spaces, "- Company Name")
 *   - Notes/sub-items: depth-1+ bullet items (4+ leading spaces, "    - Note text")
 *   - Also supports **bold** standalone lines and ## headings as section headers (legacy format)
 *
 * State machine:
 *
 *   initial
 *     │  * * * followed by date line
 *     ▼
 *   in-week ──▶ section header found ──▶ in-section
 *                                              │  depth-0 bullet (not section) found
 *                                              ▼
 *                                        in-company (accumulate notes from depth-1+ bullets)
 *                                              │  next depth-0 bullet / section / date
 *                                              ▼
 *                                        flush item
 */
function parseMarkdown(markdown) {
  const lines = markdown.split('\n')
  const weeks = []

  let currentWeekOf = null
  let currentRawDate = null
  let currentDocSection = null   // lowercase key from SECTION_MAP
  let currentAppSection = 'other'
  let currentCompanyName = null
  let currentNotes = []
  let currentItems = []
  // Guard: only start a new week after a * * * page-break marker.
  // Prevents TOC date references at the top of the doc from triggering spurious weeks.
  let seenPageBreak = false

  function flushItem() {
    const hasNotes = currentNotes.length > 0
    const hasCompany = currentCompanyName !== null
    const isAdminSection = currentDocSection ? ADMIN_SECTIONS.has(currentDocSection) : false

    if (hasCompany || (hasNotes && isAdminSection)) {
      currentItems.push({
        companyName: currentCompanyName,
        docSection: currentDocSection,
        appSection: currentAppSection,
        notes: currentNotes.join('\n').trim(),
        // matchOnly: don't create a new company record if no DB match (e.g. priorities items)
        matchOnly: currentCompanyName !== null && MATCH_ONLY_SECTIONS.has(currentAppSection),
      })
    } else if (hasNotes && !hasCompany) {
      // Unattributed content — preamble or content not under a company name
      currentItems.push({
        companyName: null,
        docSection: currentDocSection || 'other',
        appSection: currentAppSection || 'other',
        notes: currentNotes.join('\n').trim(),
      })
    }
    currentCompanyName = null
    currentNotes = []
  }

  function flushWeek() {
    if (currentWeekOf) {
      flushItem()
      if (currentItems.length > 0) {
        weeks.push({ weekOf: currentWeekOf, rawDate: currentRawDate, items: currentItems })
      }
    }
    currentWeekOf = null
    currentRawDate = null
    currentDocSection = null
    currentAppSection = 'other'
    currentCompanyName = null
    currentNotes = []
    currentItems = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Page break marker (produced by turndown from <hr>)
    if (trimmed === '---' || trimmed === '* * *' || trimmed === '***') {
      // Don't flush week here — wait for a date line to confirm new week
      flushItem()
      seenPageBreak = true
      continue
    }

    // Date-only line → start of a new week (only after a page-break marker to avoid TOC entries)
    if (seenPageBreak && isDateOnlyLine(trimmed)) {
      seenPageBreak = false
      flushWeek()
      const d = parseDate(trimmed)
      if (!d) {
        console.warn(`[warn] Could not parse date: "${trimmed}" — skipping`)
        continue
      }
      currentWeekOf = tuesdayOf(d)
      currentRawDate = trimmed
      continue
    }

    // Only process content lines once we're inside a week
    if (!currentWeekOf) continue

    // Detect depth-0 bullet: "- text" with no leading spaces (or minimal)
    // These are company/item names in this document.
    const depth0BulletMatch = line.match(/^(-|\*|\+)\s+(.+)/)
    const isDepth0Bullet = depth0BulletMatch && !line.match(/^\s+/)

    // Detect depth-1+ bullet: "    - text" with leading spaces
    // These are notes/sub-items under a company.
    const isIndentedBullet = /^\s{2,}(-|\*|\+)\s+/.test(line)

    // Detect bold-only or heading-only line (legacy format support)
    const isBoldOrHeading = /^\*\*[^*]+\*\*$/.test(trimmed) || /^#{1,6}\s+\S/.test(trimmed)

    if (isDepth0Bullet || isBoldOrHeading) {
      // Extract the text content
      const rawText = isDepth0Bullet
        ? depth0BulletMatch[2].trim().replace(/^\*\*(.+)\*\*$/, '$1').replace(/^#{1,6}\s+/, '').trim()
        : stripMarkdownWrappers(trimmed)

      // Strip markdown image and link syntax.
      // Google Docs wraps all links with google.com redirect URLs, causing false fuzzy matches.
      // Turndown also renders un-embedded images as ![] — strip those entirely.
      const text = rawText
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // ![alt](url) → '' (strip inline images)
        .replace(/!\[[^\]]*\]/g, '')                 // ![] → '' (strip broken image refs)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // [text](url) → text
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')   // [text][ref] → text
        .replace(/\u00A0/g, ' ')                    // normalize non-breaking spaces (common in Google Docs)
        .trim()

      const textLower = text.replace(/:$/, '').trim().toLowerCase()

      // Check if it's a known section header
      if (Object.prototype.hasOwnProperty.call(SECTION_MAP, textLower)) {
        flushItem()
        currentDocSection = textLower
        currentAppSection = SECTION_MAP[textLower]
        continue
      }

      // Normalize "Company: Name" prefix and "[STATUS] Name" prefix.
      // Turndown escapes brackets, so "[PASS]" in the doc becomes "\[PASS\]" in markdown.
      const cleanedText = text
        .replace(/^company:\s*/i, '')              // "Company: Gigsy" → "Gigsy"
        .replace(/^\\?\[?PASS\\?\]?\s*/i, '')      // "[PASS] Co", "\[PASS\] Co", "PASS Co" → "Co"

      // Extract company name from bullet text that includes inline description:
      //   "Company Name - some description"  →  "Company Name"
      //   "Company Name \- some description" →  "Company Name"  (turndown escapes dashes)
      //   "Company Name; some context"       →  "Company Name"
      //   "Company Name: description"        →  "Company Name"
      //   "Company Name (context note)"      →  "Company Name"
      //   "Company Name / Pass"              →  "Company Name"
      // This happens when the top-level bullet mixes the name with deal context.
      let companyName = cleanedText
      // Match both ' - ' and ' \- ' (turndown escapes literal dashes in some contexts)
      // Known status/annotation words that appear after a dash: "Company - PASS", "Company - CRM"
      const STATUS_WORDS = /^(pass|passed|passing|monitor|monitoring|crm|miss|missable|revisiting|vc|out|hold)\b/i
      const dashMatch = cleanedText.match(/ \\?- /)
      if (dashMatch && dashMatch.index > 0) {
        const afterDash = cleanedText.slice(dashMatch.index + dashMatch[0].length).trim()
        // Truncate if: description has a space/digit, OR it's a known status word, OR it's ALL_CAPS
        if (/[\s\d]/.test(afterDash) || STATUS_WORDS.test(afterDash) || /^[A-Z\s/]+$/.test(afterDash)) {
          companyName = cleanedText.slice(0, dashMatch.index).trim()
        }
      }
      // Truncate at ": description" when it looks like a description follows
      const colonIdx = companyName.indexOf(': ')
      if (colonIdx > 0) {
        const afterColon = companyName.slice(colonIdx + 2).trim()
        // Truncate if: description has a space (sentence) OR starts with a digit (metric)
        if (/\s/.test(afterColon) || /^\d/.test(afterColon)) {
          companyName = companyName.slice(0, colonIdx).trim()
        }
      }
      // Also truncate at semicolon-space: "Company Name; context" → "Company Name"
      const semiIdx = companyName.indexOf('; ')
      if (semiIdx > 0) {
        companyName = companyName.slice(0, semiIdx).trim()
      }
      // Truncate at " / " for pass/status annotations: "Company / Pass" → "Company"
      const slashIdx = companyName.indexOf(' / ')
      if (slashIdx > 0) {
        companyName = companyName.slice(0, slashIdx).trim()
      }
      // Strip trailing parenthetical content: "Oddball (Deck; Granola)" → "Oddball"
      // Also strip unclosed parens: "Oddball (Deck" → "Oddball"
      // Happens when bullet has inline links like "(Deck; [Granola](url))" after link-stripping.
      const withoutParen = companyName
        .replace(/\s*\([^)]+\)\s*$/, '')     // strip closed parens
        .replace(/\s*\([^)]*$/, '')           // strip unclosed trailing paren
        .trim()
      if (withoutParen) companyName = withoutParen

      // Only treat as a company/item name in sections that contain companies.
      // In admin/other sections, depth-0 bullets are action items or agenda entries — add as notes.
      if (
        COMPANY_SECTIONS.has(currentAppSection) ||
        MATCH_ONLY_SECTIONS.has(currentAppSection)
      ) {
        flushItem()
        currentCompanyName = companyName
      } else {
        // Non-company section: treat depth-0 bullet as content, same as indented bullets
        currentNotes.push(line.trimEnd())
      }
      continue
    }

    // Plain text (non-bullet) line — could be a section header or notes content
    if (trimmed && !isIndentedBullet) {
      const textLower = trimmed.replace(/:$/, '').trim().toLowerCase()
      // Strip bold and heading wrappers to check for section names
      const unwrapped = stripMarkdownWrappers(trimmed)
      const unwrappedLower = unwrapped.replace(/:$/, '').trim().toLowerCase()

      if (
        Object.prototype.hasOwnProperty.call(SECTION_MAP, textLower) ||
        Object.prototype.hasOwnProperty.call(SECTION_MAP, unwrappedLower)
      ) {
        flushItem()
        const sectionKey = SECTION_MAP[textLower] ? textLower : unwrappedLower
        currentDocSection = sectionKey
        currentAppSection = SECTION_MAP[sectionKey]
        continue
      }
    }

    // Everything else: notes content — append to current item notes
    if (trimmed) {
      currentNotes.push(line.trimEnd())
    } else if (currentNotes.length > 0) {
      // Empty line: only add if we already have content (avoids leading blank lines)
      currentNotes.push('')
    }
  }

  flushWeek()
  return weeks
}

// ─── COMPANY MATCHER ──────────────────────────────────────────────────────────
// Pattern adapted from loadCompanyMatcher() in scripts/import-memos-from-google-docs.js.

function buildCompanyMatcher(db) {
  const companies = db.prepare('SELECT id, canonical_name, normalized_name FROM org_companies').all()
  const aliasRows = db
    .prepare("SELECT company_id, alias_value FROM org_company_aliases WHERE alias_type = 'name'")
    .all()

  const normalizedMap = new Map()
  const compactMap = new Map()

  for (const company of companies) {
    const norm = normalizeName(company.normalized_name || company.canonical_name)
    const compact = compactName(company.canonical_name)
    if (norm && !normalizedMap.has(norm)) normalizedMap.set(norm, company)
    if (compact && !compactMap.has(compact)) compactMap.set(compact, company)
  }

  for (const row of aliasRows) {
    const aliasNorm = normalizeName(row.alias_value)
    if (!aliasNorm || normalizedMap.has(aliasNorm)) continue
    const company = companies.find((c) => c.id === row.company_id)
    if (company) normalizedMap.set(aliasNorm, company)
  }

  return function matchCompany(rawName) {
    // Strip residual markdown links before matching (defensive — parser should already clean these)
    const name = rawName.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()

    // 1. Exact normalized match
    const normalized = normalizeName(name)
    if (normalizedMap.has(normalized)) {
      return { company: normalizedMap.get(normalized), matchedBy: 'exact' }
    }

    // 2. Compact match (strips all non-alphanumeric)
    const compact = compactName(name)
    if (compact && compactMap.has(compact)) {
      return { company: compactMap.get(compact), matchedBy: 'compact' }
    }

    // 3. Token overlap + Levenshtein fuzzy (same scoring as import-memos-from-google-docs.js)
    const candidateTokens = tokenizeName(name)
    let best = null

    for (const company of companies) {
      const companyCompact = compactName(company.canonical_name)
      if (!companyCompact) continue

      let score = 0

      if (compact && (compact.includes(companyCompact) || companyCompact.includes(compact))) {
        score += 5
      }

      const distance = levenshteinDistance(compact, companyCompact)
      const maxLen = Math.max(compact.length, companyCompact.length)
      if (maxLen >= 6 && distance <= 2) score += 4

      const companyTokens = tokenizeName(company.canonical_name)
      const overlap = candidateTokens.filter((t) => companyTokens.includes(t)).length
      score += overlap

      if (!best || score > best.score) best = { company, score }
    }

    if (best && best.score >= 4) {
      return { company: best.company, matchedBy: 'fuzzy' }
    }

    return null
  }
}

// ─── CONTACT LINKER ───────────────────────────────────────────────────────────

function buildContactLinker(db) {
  const contacts = db
    .prepare("SELECT id, full_name FROM contacts WHERE full_name IS NOT NULL AND full_name != ''")
    .all()

  // Reverse token index: lowercase token → Set of contacts
  // Pre-filters candidates before running Jaro-Winkler (avoids O(bigrams × all contacts)).
  const tokenIndex = new Map()
  for (const c of contacts) {
    for (const token of c.full_name.toLowerCase().split(/\s+/)) {
      if (token.length < 2) continue
      if (!tokenIndex.has(token)) tokenIndex.set(token, [])
      tokenIndex.get(token).push(c)
    }
  }

  /**
   * Scan markdown text for contact name mentions and replace with links.
   * Returns { text: string, count: number }.
   * Threshold 0.92 (not 0.88) to reduce false positives:
   * at 0.88, "Sarah Chen" ≈ "Sam Chen" (~0.90); at 0.92, only near-exact matches.
   */
  return function linkContacts(text, weekOf, companyLabel) {
    const words = text.split(/(\s+)/)  // preserve whitespace tokens for reconstruction
    const wordTokens = words.filter((_, i) => i % 2 === 0)  // even indices are words
    const count = wordTokens.length

    const substitutions = []

    // Try trigrams first, then bigrams (longer matches take priority)
    for (let windowSize = 3; windowSize >= 2; windowSize--) {
      for (let i = 0; i <= count - windowSize; i++) {
        const phrase = wordTokens.slice(i, i + windowSize).join(' ')
        const phraseTokens = phrase.toLowerCase().split(/\s+/)

        // Require phrase to look like a proper name:
        //   - Every token ≥ 3 chars (rejects "in", "of", "at", "-", single chars)
        //   - At least one token starts with an uppercase letter in the original text
        // This eliminates false positives from common words like "investors in", "data -".
        const phraseLooksLikeName =
          phraseTokens.every(t => t.length >= 3) &&
          phrase.split(/\s+/).some(t => /^[A-Z]/.test(t))
        if (!phraseLooksLikeName) continue

        // Pre-filter: only proceed if any phrase token is in the index
        const candidates = new Set()
        for (const token of phraseTokens) {
          for (const c of tokenIndex.get(token) || []) candidates.add(c)
        }
        if (candidates.size === 0) continue

        // Run Jaro-Winkler only against pre-filtered candidates
        for (const contact of candidates) {
          const score = jaroWinkler(phrase.toLowerCase(), contact.full_name.toLowerCase())
          if (score >= 0.92) {
            substitutions.push({ phrase, contact, score })
            break
          }
        }
      }
    }

    if (substitutions.length === 0) return { text, count: 0 }

    // Deduplicate by contact id (keep highest score)
    const byContact = new Map()
    for (const sub of substitutions) {
      const existing = byContact.get(sub.contact.id)
      if (!existing || sub.score > existing.score) byContact.set(sub.contact.id, sub)
    }

    let result = text
    let applied = 0

    for (const sub of byContact.values()) {
      const link = `[${sub.contact.full_name}](/#/contact/${sub.contact.id})`
      // Only replace if not already inside a markdown link ([...) or URL (...)
      const safePattern = new RegExp(
        `(?<!\\[)(?<!\\()${sub.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\])(?!\\))`,
        'i'
      )
      if (safePattern.test(result)) {
        result = result.replace(safePattern, link)
        applied++
        console.log(
          `  [contact-link] "${sub.phrase}" → ${sub.contact.full_name} (id: ${sub.contact.id}, score: ${sub.score.toFixed(3)}) in ${weekOf} / ${companyLabel}`
        )
      }
    }

    return { text: result, count: applied }
  }
}

// ─── COMPANY CROSS-LINKER ─────────────────────────────────────────────────────

/**
 * Replace exact company name mentions in notes text with markdown links.
 * Only matches canonical names exactly (case-insensitive, word boundaries).
 * Skips the item's own company to avoid self-linking.
 * Skips text already inside a markdown link.
 */
function buildCompanyLinker(db) {
  const companies = db.prepare('SELECT id, canonical_name FROM org_companies').all()

  return function linkCompanies(text, exceptCompanyId) {
    let result = text
    for (const company of companies) {
      if (company.id === exceptCompanyId) continue
      const escaped = company.canonical_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<!\\[)\\b${escaped}\\b(?!\\])`, 'gi')
      result = result.replace(re, `[${company.canonical_name}](/#/company/${company.id})`)
    }
    return result
  }
}

// ─── DB UTILITIES ─────────────────────────────────────────────────────────────

function backupDb(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.partner-doc-backup-${stamp}`
  fs.copyFileSync(dbPath, backupPath)
  return backupPath
}

function genId() {
  return crypto.randomUUID()
}

function nowIso() {
  return new Date().toISOString()
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv)

  if (!fs.existsSync(options.htmlPath)) {
    throw new Error(`HTML file not found: ${options.htmlPath}`)
  }
  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`Database file not found: ${options.dbPath}`)
  }

  if (options.dryRun) {
    console.log('[DRY RUN] No changes will be written to the database.\n')
  }

  const db = new Database(options.dbPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  if (options.backup && !options.dryRun) {
    const backupPath = backupDb(options.dbPath)
    console.log(`DB backup created: ${backupPath}\n`)
  }

  // Parse HTML → markdown → week structures
  const html = fs.readFileSync(options.htmlPath, 'utf8')
  const markdown = htmlToMarkdown(html, options.htmlPath)
  const weeks = parseMarkdown(markdown)

  console.log(`Parsed ${weeks.length} weeks from document.`)

  if (weeks.length === 0) {
    console.error(
      '\n[error] No weeks parsed. Ensure the HTML export contains page-break divs and date-only separator pages.'
    )
    process.exit(1)
  }

  // Sort chronologically (oldest first)
  weeks.sort((a, b) => a.weekOf.localeCompare(b.weekOf))

  // Build matchers
  const matchCompany = buildCompanyMatcher(db)
  const linkContacts = buildContactLinker(db)
  const linkCompanies = buildCompanyLinker(db)

  // Prepared statements
  const existingDigestStmt = db.prepare(
    "SELECT id FROM partner_meeting_digests WHERE week_of = ? AND status = 'archived'"
  )
  const insertDigest = db.prepare(`
    INSERT INTO partner_meeting_digests
      (id, week_of, status, dismissed_suggestions, archived_at, created_at, updated_at)
    VALUES (?, ?, 'archived', '[]', ?, ?, ?)
  `)
  const insertItem = db.prepare(`
    INSERT INTO partner_meeting_items
      (id, digest_id, company_id, section, position, title, meeting_notes, is_discussed, carry_over, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `)
  const insertCompany = db.prepare(`
    INSERT INTO org_companies
      (id, canonical_name, normalized_name, entity_type, include_in_companies_view, status, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', 0, 'active', ?, ?)
  `)

  // Stats
  let weeksIngested = 0
  let weeksSkipped = 0
  let companiesMatched = 0
  let companiesCreated = 0
  let contactLinks = 0

  for (const week of weeks) {
    console.log(`\n[WEEK] ${week.weekOf}  (${week.rawDate})`)

    // Idempotency check
    const existing = existingDigestStmt.get(week.weekOf)
    if (existing) {
      console.log(`  ← SKIPPED (already in DB: ${existing.id})`)
      weeksSkipped++
      continue
    }

    // Resolve each item in this week
    const resolvedItems = []

    for (const item of week.items) {
      const isAdminSection = item.docSection ? ADMIN_SECTIONS.has(item.docSection) : false
      const notePrefix = (item.docSection && NOTE_PREFIXES[item.docSection]) || ''

      // Admin section or no company name → admin item (no company link)
      if (isAdminSection || !item.companyName) {
        const notes = (notePrefix + item.notes).trim() || null
        const title = item.companyName || 'General Notes'
        resolvedItems.push({ companyId: null, section: item.appSection, title, notes, label: title })
        console.log(`  [ADMIN]   ${title} → ${item.appSection}`)
        continue
      }

      // Company item — match or create
      const match = matchCompany(item.companyName)
      let companyId = null
      let companyLabel = item.companyName

      if (match) {
        companyId = match.company.id
        companyLabel = match.company.canonical_name
        companiesMatched++
        const tag = match.matchedBy === 'exact' ? '[MATCH]' : match.matchedBy === 'compact' ? '[MATCH]' : '[FUZZY]'
        const detail = match.matchedBy !== 'exact' ? ` (${match.matchedBy})` : ''
        console.log(`  ${tag}   "${item.companyName}" → "${companyLabel}"${detail}`)
      } else if (item.matchOnly) {
        // matchOnly section (e.g. priorities): no DB match → skip company link, store as admin item
        // Prevents action items like "Taxes", "Fundraising" from becoming company records.
        console.log(`  [SKIP]    "${item.companyName}" → no match (priorities item, not creating)`)
        companyId = null
        companyLabel = item.companyName
      } else if (item.companyName.split(/\s+/).length > 4) {
        // Word-count guard: names > 4 words are almost certainly sentences, not company names.
        // (e.g. "Flock putting some points on the board", "EF Demo Day highlights")
        console.log(`  [SKIP]    "${item.companyName}" → too long to be a company name, skipping`)
        companyId = null
        companyLabel = item.companyName
      } else if (/[$%]/.test(item.companyName) || /^\d/.test(item.companyName) || item.companyName.endsWith(':')) {
        // Metrics guard: names with $ / % / leading digits / trailing colon are metrics or labels
        // (e.g. "AOV: $70.50", "CAC: $28", "GEO companies:")
        console.log(`  [SKIP]    "${item.companyName}" → looks like a metric or label, skipping`)
        companyId = null
        companyLabel = item.companyName
      } else if (item.companyName.includes('https://') || item.companyName.includes('http://')) {
        // URL bleedthrough: Google Docs split hyperlinks sometimes create "NameURLRest" artifacts
        console.log(`  [SKIP]    "${item.companyName}" → contains URL bleedthrough, skipping`)
        companyId = null
        companyLabel = item.companyName
      } else {
        // Create new company (hidden from Companies view until manually reviewed)
        companyId = genId()
        companyLabel = item.companyName
        const normalizedCompanyName = normalizeName(companyLabel)
        const ts = nowIso()
        companiesCreated++
        console.log(`  [NEW]     "${item.companyName}" → will create (no match found)`)
        if (!options.dryRun) {
          try {
            insertCompany.run(companyId, companyLabel, normalizedCompanyName, ts, ts)
          } catch (err) {
            console.warn(`  [warn] Could not create company "${companyLabel}": ${err.message}`)
            companyId = null
          }
        }
      }

      // Apply note prefix, then cross-link companies + contacts
      let notes = (notePrefix + item.notes).trim()
      if (notes) {
        notes = linkCompanies(notes, companyId)
        const { text: linkedNotes, count } = linkContacts(notes, week.weekOf, companyLabel)
        notes = linkedNotes
        contactLinks += count
      }

      resolvedItems.push({
        companyId,
        section: item.appSection,
        title: null,
        notes: notes || null,
        label: companyLabel,
      })
    }

    if (resolvedItems.length === 0) {
      console.log('  (no items — skipping week)')
      continue
    }

    if (options.dryRun) {
      weeksIngested++
      continue
    }

    // Deduplicate by companyId within a week: the same company can appear in multiple sections
    // (e.g. "Existing Deals" and "Priorities"). Keep the first section assignment and merge notes.
    const deduped = []
    const seenCompanyIds = new Map()  // companyId → index in deduped[]
    for (const item of resolvedItems) {
      if (item.companyId && seenCompanyIds.has(item.companyId)) {
        const existing = deduped[seenCompanyIds.get(item.companyId)]
        // Merge notes from duplicate into first occurrence
        if (item.notes) {
          existing.notes = existing.notes ? existing.notes + '\n\n' + item.notes : item.notes
        }
      } else {
        if (item.companyId) seenCompanyIds.set(item.companyId, deduped.length)
        deduped.push(item)
      }
    }

    // Write to DB in a single transaction
    try {
      db.transaction(() => {
        const digestId = genId()
        const ts = nowIso()
        const archivedAt = week.weekOf + 'T23:59:59.000Z'

        insertDigest.run(digestId, week.weekOf, archivedAt, ts, ts)

        // Assign positions within each section sequentially
        const sectionPositions = new Map()
        for (const item of deduped) {
          const pos = (sectionPositions.get(item.section) || 0) + 1
          sectionPositions.set(item.section, pos)
          insertItem.run(genId(), digestId, item.companyId, item.section, pos, item.title, item.notes, ts, ts)
        }
      })()
      weeksIngested++
    } catch (err) {
      console.error(`  [error] Week ${week.weekOf} failed — rolled back: ${err.message}`)
    }
  }

  // Final summary
  const bar = '─'.repeat(60)
  console.log(`\n${bar}`)
  console.log(options.dryRun ? 'DRY RUN complete — no changes written.' : 'Import complete.')
  console.log(
    `✓ ${weeksIngested} weeks ingested | ` +
      `${companiesMatched} companies matched | ` +
      `${companiesCreated} companies created | ` +
      `${contactLinks} contact links | ` +
      `${weeksSkipped} weeks skipped (duplicate)`
  )
  if (options.dryRun) {
    console.log(`\nRe-run without --dry-run to write to DB.`)
  }
}

main()
