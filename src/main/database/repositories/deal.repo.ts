import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import {
  getDefaultPipelineConfig,
  listPipelineStages
} from './pipeline-config.repo'
import type {
  CompanyActiveDeal,
  DealStageHistoryEvent,
  PipelineBoard,
  PipelineConfig,
  PipelineDealCard,
  PipelineStage,
  PipelineSummaryItem,
  StuckDealItem
} from '../../../shared/types/pipeline'

interface DealCardRow {
  id: string
  company_id: string
  company_name: string
  stage_id: string | null
  stage_label: string
  stage_color: string | null
  stage_duration_days: number | null
  last_touchpoint: string | null
  contact_name: string | null
  contact_email: string | null
  created_at: string
  updated_at: string
}

interface DealEventRow {
  id: string
  deal_id: string
  from_stage: string | null
  to_stage: string
  event_time: string
  note: string | null
  source: string
}

interface DealRow {
  id: string
  company_id: string
  stage_id: string | null
  stage: string
  stage_updated_at: string
  created_at: string
  updated_at: string
}

function mapDealCard(row: DealCardRow): PipelineDealCard {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    stageId: row.stage_id,
    stageLabel: row.stage_label,
    stageColor: row.stage_color,
    stageDurationDays: row.stage_duration_days || 0,
    lastTouchpoint: row.last_touchpoint,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapDealEvent(row: DealEventRow): DealStageHistoryEvent {
  return {
    id: row.id,
    dealId: row.deal_id,
    fromStage: row.from_stage,
    toStage: row.to_stage,
    eventTime: row.event_time,
    note: row.note,
    source: row.source
  }
}

function getPipelineConfig(configId?: string): PipelineConfig {
  if (!configId) return getDefaultPipelineConfig()
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, name, is_default, created_at
      FROM pipeline_configs
      WHERE id = ?
      LIMIT 1
    `)
    .get(configId) as {
    id: string
    name: string
    is_default: number
    created_at: string
  } | undefined
  if (!row) {
    return getDefaultPipelineConfig()
  }
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    createdAt: row.created_at
  }
}

function listDealsForStages(stages: PipelineStage[]): PipelineDealCard[] {
  if (stages.length === 0) return []
  const db = getDatabase()
  const stageIds = stages.map((stage) => stage.id)
  const placeholders = stageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      WITH company_touch AS (
        SELECT
          c.id AS company_id,
          COALESCE(
            CASE
              WHEN m.last_meeting_at IS NULL THEN e.last_email_at
              WHEN e.last_email_at IS NULL THEN m.last_meeting_at
              WHEN m.last_meeting_at > e.last_email_at THEN m.last_meeting_at
              ELSE e.last_email_at
            END,
            c.updated_at
          ) AS last_touchpoint
        FROM org_companies c
        LEFT JOIN (
          SELECT l.company_id, MAX(m.date) AS last_meeting_at
          FROM meeting_company_links l
          JOIN meetings m ON m.id = l.meeting_id
          GROUP BY l.company_id
        ) m ON m.company_id = c.id
        LEFT JOIN (
          SELECT l.company_id, MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
          FROM email_company_links l
          JOIN email_messages em ON em.id = l.message_id
          GROUP BY l.company_id
        ) e ON e.company_id = c.id
      ),
      primary_contact AS (
        SELECT
          occ.company_id,
          c.full_name AS contact_name,
          c.email AS contact_email,
          ROW_NUMBER() OVER (
            PARTITION BY occ.company_id
            ORDER BY occ.is_primary DESC, datetime(c.updated_at) DESC, c.full_name ASC
          ) AS row_num
        FROM org_company_contacts occ
        JOIN contacts c ON c.id = occ.contact_id
      )
      SELECT
        d.id,
        d.company_id,
        c.canonical_name AS company_name,
        d.stage_id,
        COALESCE(ps.label, d.stage) AS stage_label,
        ps.color AS stage_color,
        CAST(julianday('now') - julianday(COALESCE(d.stage_updated_at, d.updated_at, d.created_at)) AS INTEGER)
          AS stage_duration_days,
        ct.last_touchpoint,
        pc.contact_name,
        pc.contact_email,
        d.created_at,
        d.updated_at
      FROM deals d
      JOIN org_companies c ON c.id = d.company_id
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      LEFT JOIN company_touch ct ON ct.company_id = d.company_id
      LEFT JOIN primary_contact pc ON pc.company_id = d.company_id AND pc.row_num = 1
      WHERE d.stage_id IN (${placeholders})
      ORDER BY datetime(d.stage_updated_at) DESC, datetime(d.updated_at) DESC
    `)
    .all(...stageIds) as DealCardRow[]
  return rows.map(mapDealCard)
}

export function getPipelineBoard(configId?: string): PipelineBoard {
  const config = getPipelineConfig(configId)
  const stages = listPipelineStages(config.id)
  const deals = listDealsForStages(stages)
  const columns = stages.map((stage) => ({
    stage,
    deals: deals.filter((deal) => deal.stageId === stage.id)
  }))

  return {
    config,
    stages,
    deals,
    columns
  }
}

export function createDeal(data: {
  companyId: string
  stageId?: string | null
  pipelineConfigId?: string | null
  amountTargetUsd?: number | null
}, userId: string | null = null): PipelineDealCard {
  const db = getDatabase()
  const config = getPipelineConfig(data.pipelineConfigId || undefined)
  const stages = listPipelineStages(config.id)
  if (stages.length === 0) {
    throw new Error('No stages configured for pipeline')
  }

  const targetStage = data.stageId
    ? stages.find((stage) => stage.id === data.stageId) || stages[0]
    : stages[0]
  const id = randomUUID()
  db.prepare(`
    INSERT INTO deals (
      id, company_id, pipeline_name, stage, stage_id, stage_updated_at, amount_target_usd,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.companyId,
    config.name,
    targetStage.label,
    targetStage.id,
    data.amountTargetUsd ?? null,
    userId,
    userId
  )

  const board = getPipelineBoard(config.id)
  const card = board.deals.find((deal) => deal.id === id)
  if (!card) {
    throw new Error('Failed to create deal')
  }
  return card
}

export function moveDealStage(
  dealId: string,
  toStageId: string,
  note: string | null = null,
  source = 'manual',
  userId: string | null = null
): DealStageHistoryEvent {
  const db = getDatabase()
  const deal = db
    .prepare(`
      SELECT id, company_id, stage_id, stage, stage_updated_at, created_at, updated_at
      FROM deals
      WHERE id = ?
      LIMIT 1
    `)
    .get(dealId) as DealRow | undefined
  if (!deal) throw new Error('Deal not found')

  const stage = db
    .prepare(`
      SELECT id, label
      FROM pipeline_stages
      WHERE id = ?
      LIMIT 1
    `)
    .get(toStageId) as { id: string; label: string } | undefined
  if (!stage) throw new Error('Target stage not found')

  const eventId = randomUUID()
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE deals
      SET
        stage_id = ?,
        stage = ?,
        stage_updated_at = datetime('now'),
        updated_by_user_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(stage.id, stage.label, userId, dealId)

    db.prepare(`
      INSERT INTO deal_stage_events (
        id, deal_id, from_stage, to_stage, event_time, note, source,
        created_by_user_id, updated_by_user_id
      ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
    `).run(
      eventId,
      dealId,
      deal.stage || null,
      stage.label,
      note,
      source,
      userId,
      userId
    )
  })
  tx()

  const event = db
    .prepare(`
      SELECT
        id,
        deal_id,
        from_stage,
        to_stage,
        event_time,
        note,
        source
      FROM deal_stage_events
      WHERE id = ?
      LIMIT 1
    `)
    .get(eventId) as DealEventRow | undefined
  if (!event) {
    throw new Error('Failed to move deal stage')
  }
  return mapDealEvent(event)
}

export function listDealStageHistory(dealId: string): DealStageHistoryEvent[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        id,
        deal_id,
        from_stage,
        to_stage,
        event_time,
        note,
        source
      FROM deal_stage_events
      WHERE deal_id = ?
      ORDER BY datetime(event_time) DESC
    `)
    .all(dealId) as DealEventRow[]
  return rows.map(mapDealEvent)
}

export function getCompanyActiveDeal(companyId: string): CompanyActiveDeal | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        d.id,
        d.company_id,
        d.stage_id,
        COALESCE(ps.label, d.stage) AS stage_label,
        ps.color AS stage_color,
        d.stage_updated_at,
        CAST(julianday('now') - julianday(COALESCE(d.stage_updated_at, d.updated_at, d.created_at)) AS INTEGER)
          AS stage_duration_days,
        d.created_at,
        d.updated_at
      FROM deals d
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      WHERE d.company_id = ?
      ORDER BY datetime(d.updated_at) DESC
      LIMIT 1
    `)
    .get(companyId) as {
    id: string
    company_id: string
    stage_id: string | null
    stage_label: string
    stage_color: string | null
    stage_updated_at: string
    stage_duration_days: number | null
    created_at: string
    updated_at: string
  } | undefined

  if (!row) return null

  return {
    id: row.id,
    companyId: row.company_id,
    stageId: row.stage_id,
    stageLabel: row.stage_label,
    stageColor: row.stage_color,
    stageUpdatedAt: row.stage_updated_at,
    stageDurationDays: row.stage_duration_days || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    history: listDealStageHistory(row.id)
  }
}

export function getPipelineSummary(configId?: string): PipelineSummaryItem[] {
  const config = getPipelineConfig(configId)
  const stages = listPipelineStages(config.id)
  if (stages.length === 0) return []
  const db = getDatabase()
  const counts = db
    .prepare(`
      SELECT stage_id, COUNT(*) AS deal_count
      FROM deals
      WHERE stage_id IN (
        SELECT id
        FROM pipeline_stages
        WHERE pipeline_config_id = ?
      )
      GROUP BY stage_id
    `)
    .all(config.id) as Array<{ stage_id: string; deal_count: number }>
  const countByStageId = new Map(counts.map((row) => [row.stage_id, row.deal_count]))
  return stages.map((stage) => ({
    stageId: stage.id,
    label: stage.label,
    color: stage.color,
    count: countByStageId.get(stage.id) || 0
  }))
}

export function listStuckDeals(stuckDays: number, configId?: string): StuckDealItem[] {
  const config = getPipelineConfig(configId)
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH company_touch AS (
        SELECT
          c.id AS company_id,
          COALESCE(
            CASE
              WHEN m.last_meeting_at IS NULL THEN e.last_email_at
              WHEN e.last_email_at IS NULL THEN m.last_meeting_at
              WHEN m.last_meeting_at > e.last_email_at THEN m.last_meeting_at
              ELSE e.last_email_at
            END,
            c.updated_at
          ) AS last_touchpoint
        FROM org_companies c
        LEFT JOIN (
          SELECT l.company_id, MAX(m.date) AS last_meeting_at
          FROM meeting_company_links l
          JOIN meetings m ON m.id = l.meeting_id
          GROUP BY l.company_id
        ) m ON m.company_id = c.id
        LEFT JOIN (
          SELECT l.company_id, MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
          FROM email_company_links l
          JOIN email_messages em ON em.id = l.message_id
          GROUP BY l.company_id
        ) e ON e.company_id = c.id
      )
      SELECT
        d.id AS deal_id,
        d.company_id,
        c.canonical_name AS company_name,
        COALESCE(ps.label, d.stage) AS stage_label,
        CAST(julianday('now') - julianday(COALESCE(d.stage_updated_at, d.updated_at, d.created_at)) AS INTEGER)
          AS stage_duration_days,
        ct.last_touchpoint
      FROM deals d
      JOIN org_companies c ON c.id = d.company_id
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      LEFT JOIN company_touch ct ON ct.company_id = d.company_id
      WHERE d.stage_id IN (
        SELECT id
        FROM pipeline_stages
        WHERE pipeline_config_id = ? AND is_terminal = 0
      )
        AND julianday('now') - julianday(COALESCE(d.stage_updated_at, d.updated_at, d.created_at)) >= ?
      ORDER BY stage_duration_days DESC, datetime(d.updated_at) DESC
      LIMIT 30
    `)
    .all(config.id, stuckDays) as Array<{
    deal_id: string
    company_id: string
    company_name: string
    stage_label: string
    stage_duration_days: number | null
    last_touchpoint: string | null
  }>

  return rows.map((row) => ({
    dealId: row.deal_id,
    companyId: row.company_id,
    companyName: row.company_name,
    stageLabel: row.stage_label,
    stageDurationDays: row.stage_duration_days || 0,
    lastTouchpoint: row.last_touchpoint
  }))
}
