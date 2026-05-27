import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runDefaultTemplatesAttendeesPlaceholderMigration } from '@cyggie/db/sqlite/migrations/106-default-templates-attendees-placeholder'

// Migration 106 rewrites the seeded default-template rows from the
// legacy `Participants: {{speakers}}` header to `Attendees: {{attendees}}`,
// so existing users pick up the calendar-truth placeholder without a
// re-seed. The LIKE guard protects user customizations.

function makeTemplatesDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      user_prompt_template TEXT NOT NULL,
      instructions TEXT,
      output_format TEXT NOT NULL DEFAULT 'markdown',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insertTemplate(
  db: Database.Database,
  opts: {
    category: string
    userPromptTemplate: string
    isDefault: boolean
  },
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO templates (id, name, description, category, system_prompt, user_prompt_template, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    opts.category,
    '',
    opts.category,
    'sys',
    opts.userPromptTemplate,
    opts.isDefault ? 1 : 0,
  )
  return id
}

describe('migration 106 — default templates {{speakers}} → {{attendees}}', () => {
  it('rewrites a default row that still has the legacy header', () => {
    const db = makeTemplatesDb()
    const id = insertTemplate(db, {
      category: 'vc_pitch',
      userPromptTemplate: 'Meeting: x\nParticipants: {{speakers}}\n\nTranscript:\n{{transcript}}',
      isDefault: true,
    })

    runDefaultTemplatesAttendeesPlaceholderMigration(db)

    const row = db.prepare('SELECT user_prompt_template FROM templates WHERE id = ?').get(id) as {
      user_prompt_template: string
    }
    expect(row.user_prompt_template).toContain('Attendees: {{attendees}}')
    expect(row.user_prompt_template).not.toContain('Participants: {{speakers}}')
  })

  it('LIKE guard — leaves user-customized rows alone', () => {
    const db = makeTemplatesDb()
    const customized = insertTemplate(db, {
      category: 'vc_pitch',
      // User edited the header line; LIKE no longer matches.
      userPromptTemplate: 'Meeting: x\nAttending: {{speakers}}\n\nTranscript:\n{{transcript}}',
      isDefault: true,
    })

    runDefaultTemplatesAttendeesPlaceholderMigration(db)

    const row = db.prepare('SELECT user_prompt_template FROM templates WHERE id = ?').get(customized) as {
      user_prompt_template: string
    }
    expect(row.user_prompt_template).toContain('Attending: {{speakers}}')
  })

  it('skips non-default rows even if they match the legacy pattern', () => {
    const db = makeTemplatesDb()
    const nonDefault = insertTemplate(db, {
      category: 'vc_pitch',
      userPromptTemplate: 'Participants: {{speakers}}',
      isDefault: false,
    })

    runDefaultTemplatesAttendeesPlaceholderMigration(db)

    const row = db.prepare('SELECT user_prompt_template FROM templates WHERE id = ?').get(nonDefault) as {
      user_prompt_template: string
    }
    // Non-default rows are user creations — never touched.
    expect(row.user_prompt_template).toBe('Participants: {{speakers}}')
  })

  it('idempotent — second run is a no-op', () => {
    const db = makeTemplatesDb()
    const id = insertTemplate(db, {
      category: 'general',
      userPromptTemplate: 'Participants: {{speakers}}',
      isDefault: true,
    })

    runDefaultTemplatesAttendeesPlaceholderMigration(db)
    const after1 = db
      .prepare('SELECT user_prompt_template, updated_at FROM templates WHERE id = ?')
      .get(id) as { user_prompt_template: string; updated_at: string }
    expect(after1.user_prompt_template).toContain('Attendees: {{attendees}}')

    // Second run: should not match the LIKE guard, so updated_at stays.
    runDefaultTemplatesAttendeesPlaceholderMigration(db)
    const after2 = db
      .prepare('SELECT user_prompt_template, updated_at FROM templates WHERE id = ?')
      .get(id) as { user_prompt_template: string; updated_at: string }
    expect(after2.user_prompt_template).toBe(after1.user_prompt_template)
    expect(after2.updated_at).toBe(after1.updated_at)
  })

  it('no-op when templates table does not exist (early-launch ordering)', () => {
    const db = new Database(':memory:')
    expect(() => runDefaultTemplatesAttendeesPlaceholderMigration(db)).not.toThrow()
  })
})
