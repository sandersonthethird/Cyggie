import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { PipelineConfig, PipelineStage } from '../../../shared/types/pipeline'

interface PipelineConfigRow {
  id: string
  name: string
  is_default: number
  created_at: string
}

interface PipelineStageRow {
  id: string
  pipeline_config_id: string
  label: string
  slug: string
  sort_order: number
  color: string | null
  is_terminal: number
  created_at: string
}

function mapConfig(row: PipelineConfigRow): PipelineConfig {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    createdAt: row.created_at
  }
}

function mapStage(row: PipelineStageRow): PipelineStage {
  return {
    id: row.id,
    pipelineConfigId: row.pipeline_config_id,
    label: row.label,
    slug: row.slug,
    sortOrder: row.sort_order,
    color: row.color,
    isTerminal: row.is_terminal === 1,
    createdAt: row.created_at
  }
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function ensureDefaultPipelineConfigId(): string {
  const db = getDatabase()
  const existing = db
    .prepare(`
      SELECT id
      FROM pipeline_configs
      WHERE is_default = 1
      LIMIT 1
    `)
    .get() as { id: string } | undefined

  if (existing?.id) return existing.id

  const fallback = db
    .prepare(`
      SELECT id
      FROM pipeline_configs
      ORDER BY datetime(created_at) ASC
      LIMIT 1
    `)
    .get() as { id: string } | undefined
  if (fallback?.id) {
    db.prepare(`
      UPDATE pipeline_configs
      SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END
    `).run(fallback.id)
    return fallback.id
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO pipeline_configs (id, name, is_default, created_at)
    VALUES (?, 'Default VC Pipeline', 1, datetime('now'))
  `).run(id)
  return id
}

function ensureAtLeastOneStage(configId: string): void {
  const db = getDatabase()
  const existing = db
    .prepare(`
      SELECT id
      FROM pipeline_stages
      WHERE pipeline_config_id = ?
      LIMIT 1
    `)
    .get(configId) as { id: string } | undefined
  if (existing?.id) return

  const id = randomUUID()
  db.prepare(`
    INSERT INTO pipeline_stages (
      id, pipeline_config_id, label, slug, sort_order, color, is_terminal, created_at
    ) VALUES (?, ?, 'Sourced', 'sourced', 0, '#5A7DA3', 0, datetime('now'))
  `).run(id, configId)
}

export function listPipelineConfigs(): PipelineConfig[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, name, is_default, created_at
      FROM pipeline_configs
      ORDER BY is_default DESC, datetime(created_at) ASC
    `)
    .all() as PipelineConfigRow[]
  return rows.map(mapConfig)
}

export function getDefaultPipelineConfig(): PipelineConfig {
  const configId = ensureDefaultPipelineConfigId()
  ensureAtLeastOneStage(configId)
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, name, is_default, created_at
      FROM pipeline_configs
      WHERE id = ?
      LIMIT 1
    `)
    .get(configId) as PipelineConfigRow | undefined
  if (!row) {
    throw new Error('Failed to load default pipeline config')
  }
  return mapConfig(row)
}

export function listPipelineStages(pipelineConfigId?: string): PipelineStage[] {
  const configId = pipelineConfigId || getDefaultPipelineConfig().id
  ensureAtLeastOneStage(configId)
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        id,
        pipeline_config_id,
        label,
        slug,
        sort_order,
        color,
        is_terminal,
        created_at
      FROM pipeline_stages
      WHERE pipeline_config_id = ?
      ORDER BY sort_order ASC, datetime(created_at) ASC
    `)
    .all(configId) as PipelineStageRow[]
  return rows.map(mapStage)
}

export function upsertPipelineStage(data: {
  id?: string
  pipelineConfigId?: string
  label: string
  slug?: string
  sortOrder?: number
  color?: string | null
  isTerminal?: boolean
  userId?: string | null
}): PipelineStage {
  const db = getDatabase()
  const configId = data.pipelineConfigId || getDefaultPipelineConfig().id
  const label = data.label.trim()
  if (!label) throw new Error('Stage label is required')
  const slug = normalizeSlug(data.slug || label)
  if (!slug) throw new Error('Stage slug is required')

  if (data.id) {
    const stage = db
      .prepare(`
        SELECT id, pipeline_config_id, sort_order
        FROM pipeline_stages
        WHERE id = ?
        LIMIT 1
      `)
      .get(data.id) as { id: string; pipeline_config_id: string; sort_order: number } | undefined
    if (!stage) {
      throw new Error('Stage not found')
    }

    const nextSortOrder = data.sortOrder ?? stage.sort_order
    db.prepare(`
      UPDATE pipeline_stages
      SET label = ?, slug = ?, sort_order = ?, color = ?, is_terminal = ?
      WHERE id = ?
    `).run(
      label,
      slug,
      nextSortOrder,
      data.color ?? null,
      data.isTerminal ? 1 : 0,
      data.id
    )

    db.prepare(`
      UPDATE deals
      SET stage = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE stage_id = ?
    `).run(label, data.userId ?? null, data.id)
  } else {
    const maxSortOrder = db
      .prepare(`
        SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
        FROM pipeline_stages
        WHERE pipeline_config_id = ?
      `)
      .get(configId) as { max_sort_order: number }
    const sortOrder = data.sortOrder ?? (maxSortOrder.max_sort_order + 1)
    const id = randomUUID()
    db.prepare(`
      INSERT INTO pipeline_stages (
        id, pipeline_config_id, label, slug, sort_order, color, is_terminal, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      configId,
      label,
      slug,
      sortOrder,
      data.color ?? null,
      data.isTerminal ? 1 : 0,
      data.userId ?? null
    )
    data.id = id
  }

  const row = db
    .prepare(`
      SELECT
        id,
        pipeline_config_id,
        label,
        slug,
        sort_order,
        color,
        is_terminal,
        created_at
      FROM pipeline_stages
      WHERE id = ?
      LIMIT 1
    `)
    .get(data.id) as PipelineStageRow | undefined
  if (!row) {
    throw new Error('Failed to load pipeline stage')
  }
  return mapStage(row)
}

export function reorderPipelineStages(
  pipelineConfigId: string,
  orderedStageIds: string[]
): PipelineStage[] {
  const db = getDatabase()
  const tx = db.transaction((stageIds: string[]) => {
    stageIds.forEach((stageId, index) => {
      db.prepare(`
        UPDATE pipeline_stages
        SET sort_order = ?
        WHERE id = ? AND pipeline_config_id = ?
      `).run(index, stageId, pipelineConfigId)
    })
  })
  tx(orderedStageIds)
  return listPipelineStages(pipelineConfigId)
}

export function deletePipelineStage(
  stageId: string,
  fallbackStageId: string | null = null,
  userId: string | null = null
): PipelineStage[] {
  const db = getDatabase()
  const stage = db
    .prepare(`
      SELECT id, pipeline_config_id
      FROM pipeline_stages
      WHERE id = ?
      LIMIT 1
    `)
    .get(stageId) as { id: string; pipeline_config_id: string } | undefined
  if (!stage) {
    throw new Error('Stage not found')
  }

  const candidates = db
    .prepare(`
      SELECT id, label
      FROM pipeline_stages
      WHERE pipeline_config_id = ? AND id <> ?
      ORDER BY sort_order ASC, datetime(created_at) ASC
    `)
    .all(stage.pipeline_config_id, stageId) as Array<{ id: string; label: string }>
  if (candidates.length === 0) {
    throw new Error('Cannot delete the only stage in a pipeline')
  }

  const fallback = fallbackStageId
    ? candidates.find((candidate) => candidate.id === fallbackStageId)
    : candidates[0]
  if (!fallback) {
    throw new Error('Fallback stage not found')
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE deals
      SET stage_id = ?, stage = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE stage_id = ?
    `).run(fallback.id, fallback.label, userId, stageId)

    db.prepare(`
      DELETE FROM pipeline_stages
      WHERE id = ?
    `).run(stageId)

    const rows = db
      .prepare(`
        SELECT id
        FROM pipeline_stages
        WHERE pipeline_config_id = ?
        ORDER BY sort_order ASC, datetime(created_at) ASC
      `)
      .all(stage.pipeline_config_id) as Array<{ id: string }>
    rows.forEach((row, index) => {
      db.prepare(`
        UPDATE pipeline_stages
        SET sort_order = ?
        WHERE id = ?
      `).run(index, row.id)
    })
  })
  tx()

  return listPipelineStages(stage.pipeline_config_id)
}
