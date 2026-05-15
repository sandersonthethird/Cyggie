import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { runPriorityRenameFurtherWorkMigration } from '../main/database/migrations/095-priority-rename-further-work'

function setup() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE org_companies (id TEXT PRIMARY KEY, priority TEXT)`)
  return db
}

describe('migration 095 — priority rename further_work → medium', () => {
  it('renames further_work to medium', () => {
    const db = setup()
    db.prepare(`INSERT INTO org_companies (id, priority) VALUES ('c1', 'further_work')`).run()
    runPriorityRenameFurtherWorkMigration(db)
    const row = db.prepare(`SELECT priority FROM org_companies WHERE id='c1'`).get() as { priority: string }
    expect(row.priority).toBe('medium')
  })

  it('leaves other priority values untouched', () => {
    const db = setup()
    db.prepare(
      `INSERT INTO org_companies (id, priority) VALUES ('a', 'high'), ('b', 'medium'), ('c', 'monitor'), ('d', 'low'), ('e', NULL)`,
    ).run()
    runPriorityRenameFurtherWorkMigration(db)
    const rows = db.prepare(`SELECT id, priority FROM org_companies ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 'a', priority: 'high' },
      { id: 'b', priority: 'medium' },
      { id: 'c', priority: 'monitor' },
      { id: 'd', priority: 'low' },
      { id: 'e', priority: null },
    ])
  })

  it('is idempotent on a second run', () => {
    const db = setup()
    db.prepare(`INSERT INTO org_companies (id, priority) VALUES ('c1', 'further_work')`).run()
    runPriorityRenameFurtherWorkMigration(db)
    expect(() => runPriorityRenameFurtherWorkMigration(db)).not.toThrow()
    const row = db.prepare(`SELECT priority FROM org_companies WHERE id='c1'`).get() as { priority: string }
    expect(row.priority).toBe('medium')
  })

  it('runs cleanly against an empty table', () => {
    const db = setup()
    expect(() => runPriorityRenameFurtherWorkMigration(db)).not.toThrow()
  })
})
