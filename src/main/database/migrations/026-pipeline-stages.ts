import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_026_pipeline_stages_v1'

interface StageSeed {
  label: string
  slug: string
  color: string
  isTerminal: boolean
}

const DEFAULT_STAGES: StageSeed[] = [
  { label: 'Sourced', slug: 'sourced', color: '#5A7DA3', isTerminal: false },
  { label: 'Screening', slug: 'screening', color: '#3F88C5', isTerminal: false },
  { label: 'Diligence', slug: 'diligence', color: '#2E8B57', isTerminal: false },
  { label: 'Partner Review', slug: 'partner-review', color: '#4F7B8B', isTerminal: false },
  { label: 'Term Sheet', slug: 'term-sheet', color: '#C97B2A', isTerminal: false },
  { label: 'Closed', slug: 'closed', color: '#1D8F6B', isTerminal: true },
  { label: 'Pass', slug: 'pass', color: '#8C96A3', isTerminal: true }
]

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return Boolean(row?.name)
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) return false
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function mapLegacyStageToSlug(stage: string | null): string {
  const normalized = normalizeSlug(stage || '')
  if (!normalized) return 'sourced'
  if (normalized.includes('partner')) return 'partner-review'
  if (normalized.includes('term')) return 'term-sheet'
  if (normalized.includes('diligence')) return 'diligence'
  if (normalized.includes('screen')) return 'screening'
  if (normalized.includes('source')) return 'sourced'
  if (normalized.includes('closed') || normalized.includes('close')) return 'closed'
  if (normalized.includes('pass') || normalized.includes('reject')) return 'pass'
  return normalized
}

export function runPipelineStagesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_configs_default
      ON pipeline_configs(is_default)
      WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY,
      pipeline_config_id TEXT NOT NULL,
      label TEXT NOT NULL,
      slug TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      color TEXT,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pipeline_config_id) REFERENCES pipeline_configs(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (pipeline_config_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline
      ON pipeline_stages(pipeline_config_id, sort_order);
  `)

  if (tableExists(db, 'deals') && !columnExists(db, 'deals', 'stage_id')) {
    db.exec(`
      ALTER TABLE deals
      ADD COLUMN stage_id TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL
    `)
  }

  if (tableExists(db, 'deals')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_deals_stage_id ON deals(stage_id)')
  }

  const existingDefault = db
    .prepare('SELECT id FROM pipeline_configs WHERE is_default = 1 LIMIT 1')
    .get() as { id: string } | undefined

  const pipelineConfigId = existingDefault?.id || randomUUID()
  if (!existingDefault) {
    db.prepare(`
      INSERT INTO pipeline_configs (id, name, is_default, created_at)
      VALUES (?, 'Default VC Pipeline', 1, datetime('now'))
    `).run(pipelineConfigId)
  }

  const existingStages = db
    .prepare(`
      SELECT id, slug
      FROM pipeline_stages
      WHERE pipeline_config_id = ?
    `)
    .all(pipelineConfigId) as Array<{ id: string; slug: string }>
  const stageBySlug = new Map(existingStages.map((stage) => [stage.slug, stage.id]))

  DEFAULT_STAGES.forEach((stage, index) => {
    if (stageBySlug.has(stage.slug)) return
    const id = randomUUID()
    db.prepare(`
      INSERT INTO pipeline_stages (
        id, pipeline_config_id, label, slug, sort_order, color, is_terminal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      pipelineConfigId,
      stage.label,
      stage.slug,
      index,
      stage.color,
      stage.isTerminal ? 1 : 0
    )
    stageBySlug.set(stage.slug, id)
  })

  const freshStages = db
    .prepare(`
      SELECT id, label, slug
      FROM pipeline_stages
      WHERE pipeline_config_id = ?
      ORDER BY sort_order ASC, label ASC
    `)
    .all(pipelineConfigId) as Array<{ id: string; label: string; slug: string }>
  const fallbackStage = freshStages[0]

  if (tableExists(db, 'deals') && fallbackStage) {
    const stageLabelById = new Map(freshStages.map((stage) => [stage.id, stage.label]))
    const stageIdBySlug = new Map(freshStages.map((stage) => [stage.slug, stage.id]))
    const deals = db
      .prepare(`
        SELECT id, stage, stage_id
        FROM deals
      `)
      .all() as Array<{ id: string; stage: string | null; stage_id: string | null }>

    const updateDeal = db.prepare(`
      UPDATE deals
      SET stage_id = ?, stage = ?, updated_at = datetime('now')
      WHERE id = ?
    `)

    const tx = db.transaction((items: Array<{ id: string; stage: string | null; stage_id: string | null }>) => {
      for (const deal of items) {
        let targetStageId = deal.stage_id
        if (!targetStageId || !stageLabelById.has(targetStageId)) {
          const mappedSlug = mapLegacyStageToSlug(deal.stage)
          targetStageId = stageIdBySlug.get(mappedSlug) || fallbackStage.id
        }

        const targetLabel = stageLabelById.get(targetStageId) || fallbackStage.label
        if (deal.stage_id !== targetStageId || deal.stage !== targetLabel) {
          updateDeal.run(targetStageId, targetLabel, deal.id)
        }
      }
    })

    tx(deals)
  }

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
