import type Database from 'better-sqlite3'
import { parseFrontmatter, parseAppleNotesDate } from '../../utils/frontmatter'

/**
 * One-time data repair: strip YAML frontmatter from imported note bodies and
 * backfill created_at / updated_at from the embedded metadata.
 *
 * Apple Notes exports embed metadata at the top of each file:
 *
 *   ---
 *   title: "Jack Whitten"
 *   created: "Friday, October 30, 2020 at 7:25:21 PM"
 *   modified: "Friday, October 30, 2020 at 7:27:31 PM"
 *   folder: "Art"
 *   ---
 *
 * The importer stored this verbatim in `content` and set both `created_at`
 * and `updated_at` to import time. A subsequent auto-tagging pass bumped
 * `updated_at` to today, so all 1,311 imported notes appeared under "Today".
 *
 * This migration:
 *   1. Finds notes whose content starts with `---` (frontmatter present)
 *   2. Strips the frontmatter block from content
 *   3. Updates created_at / updated_at from the embedded dates (if parseable)
 *
 * Idempotent: after the first run, frontmatter is stripped so subsequent
 * runs find no matching notes and are no-ops.
 *
 * FTS5 sync is handled automatically by the `notes_fts_update` trigger.
 */
export function runRepairImportedNoteFrontmatterMigration(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT id, content FROM notes WHERE content LIKE '---%'`)
    .all() as Array<{ id: string; content: string }>

  if (rows.length === 0) return

  const update = db.prepare(`
    UPDATE notes
    SET content = ?, created_at = ?, updated_at = ?
    WHERE id = ?
  `)

  const updateContentOnly = db.prepare(`
    UPDATE notes SET content = ? WHERE id = ?
  `)

  let repaired = 0

  const run = db.transaction(() => {
    for (const row of rows) {
      const result = parseFrontmatter(row.content)
      if (!result) continue

      const { frontmatter, body } = result
      const createdIso = frontmatter.created ? parseAppleNotesDate(frontmatter.created) : null
      const modifiedIso = frontmatter.modified ? parseAppleNotesDate(frontmatter.modified) : null

      if (createdIso && modifiedIso) {
        update.run(body, createdIso, modifiedIso, row.id)
      } else {
        // Dates unparseable — still strip the frontmatter from the body
        updateContentOnly.run(body, row.id)
      }

      repaired++
    }
  })

  run()

  if (repaired > 0) {
    console.log(`[migration-065] Repaired ${repaired} imported notes (frontmatter stripped, dates backfilled)`)
  }
}
