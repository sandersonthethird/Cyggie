/**
 * import-apple-note.ts
 *
 * Imports one or all Apple Notes notes into the Cyggie notes table,
 * including embedded images saved to the note-assets directory.
 *
 * Usage:
 *   npx tsx src/scripts/import-apple-note.ts            # process all notes that have images
 *   npx tsx src/scripts/import-apple-note.ts "Title"    # process a single note by title
 *
 * DB:     ~/Documents/MeetingIntelligence/echovault.db
 * Assets: ~/Documents/MeetingIntelligence/note-assets/{noteId}/image-NNN.ext
 */

import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import os from 'os'
import TurndownService from 'turndown'

const STORAGE_PATH = path.join(process.env.HOME!, 'Documents/MeetingIntelligence')
const DB_PATH = path.join(STORAGE_PATH, 'echovault.db')
const USER_ID = '92a162ca-3e03-4a79-b14d-58ce1b7ed9f3'

// Max body size to attempt fetching (bytes). Red Swan Deck/Themes is 27MB — skip it.
const MAX_BODY_BYTES = 15 * 1024 * 1024

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function runSqlFile(sql: string): void {
  const f = path.join(os.tmpdir(), `cyggie-note-${Date.now()}.sql`)
  fs.writeFileSync(f, sql, 'utf8')
  try {
    execSync(`sqlite3 "${DB_PATH}" < "${f}"`)
  } finally {
    fs.unlinkSync(f)
  }
}

function querySql(sql: string): string {
  return execSync(`sqlite3 "${DB_PATH}" ${JSON.stringify(sql)}`).toString().trim()
}

function runJxa(script: string): string {
  const f = path.join(os.tmpdir(), `cyggie-jxa-${Date.now()}.js`)
  fs.writeFileSync(f, script, 'utf8')
  try {
    return execSync(`osascript -l JavaScript "${f}"`, { maxBuffer: 50 * 1024 * 1024 })
      .toString().trim()
  } finally {
    fs.unlinkSync(f)
  }
}

// ─── Fetch note list from Apple Notes ────────────────────────────────────────

function fetchNoteList(): Array<{ name: string; folder: string; bodyLen: number }> {
  console.log('Scanning Apple Notes for notes with images…')
  const raw = runJxa(`
    const notes = Application("Notes")
    const allNotes = notes.notes()
    const withImages = allNotes
      .filter(n => { try { return n.body().includes('data:image') } catch { return false } })
      .map(n => ({
        name: n.name(),
        folder: (() => { try { return n.container().name() } catch { return '' } })(),
        bodyLen: n.body().length
      }))
    JSON.stringify(withImages)
  `)
  return JSON.parse(raw)
}

// ─── Fetch a single note body ─────────────────────────────────────────────────

function fetchNoteBody(title: string): { body: string; creationDate: string; modificationDate: string; container: string } | null {
  const raw = runJxa(`
    const notes = Application("Notes")
    const allNotes = notes.notes()
    const target = allNotes.find(n => n.name() === ${JSON.stringify(title)})
    if (!target) {
      JSON.stringify({ found: false })
    } else {
      JSON.stringify({
        found: true,
        body: target.body(),
        creationDate: target.creationDate()?.toString() ?? '',
        modificationDate: target.modificationDate()?.toString() ?? '',
        container: (() => { try { return target.container().name() } catch { return '' } })()
      })
    }
  `)
  const result = JSON.parse(raw)
  if (!result.found) return null
  return result
}

// ─── Process a single note ────────────────────────────────────────────────────

function processNote(title: string, note: { body: string; creationDate: string; modificationDate: string; container: string }): {
  status: 'inserted' | 'updated' | 'skipped'
  images: number
} {
  // Determine note ID
  const existingId = querySql(
    `SELECT id FROM notes WHERE title=${sqlStr(title)} AND created_by_user_id='${USER_ID}' LIMIT 1;`
  )
  const noteId = existingId || randomUUID()

  // Extract images from HTML
  const ALLOWED_MIME_RE = /^(png|jpe?g|gif|webp)$/i
  const DATA_IMG_RE = /<img[^>]+src="data:image\/(png|jpe?g|gif|webp);base64,([^"]+)"[^>]*>/gi

  const assetsDir = path.join(STORAGE_PATH, 'note-assets', noteId)
  let imgIndex = 0
  let imagesWritten = 0

  let html = note.body
  html = html.replace(DATA_IMG_RE, (_match: string, rawMime: string, base64: string) => {
    if (!ALLOWED_MIME_RE.test(rawMime)) return '[image]'
    const ext = rawMime.toLowerCase().replace('jpeg', 'jpg')
    const filename = `image-${String(imgIndex).padStart(3, '0')}.${ext}`
    const uri = `asset://note-assets/${noteId}/${filename}`
    imgIndex++
    try {
      fs.mkdirSync(assetsDir, { recursive: true })
      fs.writeFileSync(path.join(assetsDir, filename), Buffer.from(base64, 'base64'))
      imagesWritten++
      return `<img src="${uri}">`
    } catch {
      return '[image]'
    }
  })

  // Convert HTML → Markdown
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  td.addRule('img', {
    filter: 'img',
    replacement: (_content: string, node: Node) => {
      const src = (node as HTMLImageElement).getAttribute('src') ?? ''
      return src ? `![image](${src})` : ''
    },
  })
  const markdown = td.turndown(html).trim()

  // Upsert into DB
  if (existingId) {
    runSqlFile(`UPDATE notes SET content=${sqlStr(markdown)}, updated_at=datetime('now'), updated_by_user_id='${USER_ID}' WHERE id='${noteId}';`)
    return { status: 'updated', images: imagesWritten }
  } else {
    const createdAt = note.creationDate ? new Date(note.creationDate).toISOString() : new Date().toISOString()
    const updatedAt = note.modificationDate ? new Date(note.modificationDate).toISOString() : createdAt
    const folderPath = note.container ?? ''
    runSqlFile(`INSERT INTO notes (id, title, content, folder_path, import_source, created_by_user_id, updated_by_user_id, created_at, updated_at) VALUES ('${noteId}', ${sqlStr(title)}, ${sqlStr(markdown)}, ${sqlStr(folderPath)}, 'apple-notes', '${USER_ID}', '${USER_ID}', '${createdAt}', '${updatedAt}');`)
    return { status: 'inserted', images: imagesWritten }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const singleTitle = process.argv[2]

if (singleTitle) {
  // Single-note mode
  console.log(`Fetching "${singleTitle}" from Apple Notes…`)
  const note = fetchNoteBody(singleTitle)
  if (!note) { console.error('Note not found.'); process.exit(1) }
  console.log(`Body size: ${(note.body.length / 1024).toFixed(1)} KB`)
  const { status, images } = processNote(singleTitle, note)
  console.log(`Done — ${status}, ${images} image(s) written.`)
} else {
  // Bulk mode
  const list = fetchNoteList()
  console.log(`Found ${list.length} Apple Notes with images.\n`)

  let inserted = 0, updated = 0, skipped = 0, totalImages = 0

  for (const { name, bodyLen } of list) {
    const kb = (bodyLen / 1024).toFixed(0)

    if (bodyLen > MAX_BODY_BYTES) {
      console.log(`  SKIP  ${name} (${kb} KB — exceeds ${MAX_BODY_BYTES / 1024 / 1024}MB limit)`)
      skipped++
      continue
    }

    process.stdout.write(`  …     ${name} (${kb} KB)`)
    try {
      const note = fetchNoteBody(name)
      if (!note) {
        console.log(` — not found, skipped`)
        skipped++
        continue
      }
      const { status, images } = processNote(name, note)
      console.log(` — ${status}, ${images} image(s)`)
      if (status === 'inserted') inserted++
      else updated++
      totalImages += images
    } catch (err) {
      console.log(` — ERROR: ${err}`)
      skipped++
    }
  }

  console.log(`\nDone. ${inserted} inserted, ${updated} updated, ${skipped} skipped. ${totalImages} total images written.`)
}
