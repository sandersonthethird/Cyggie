// =============================================================================
// sync-remote-apply.ts — pull-side primitive for Phase 1.5c.
//
// Applies rows pulled from Neon (`GET /sync/pull`) to the local SQLite,
// bypassing the writeWithSync barrel so the apply does NOT re-enter the
// outbox. Without this bypass we'd ping-pong (pulled row → outbox →
// pushed back → gateway LWW rejects but desktop keeps trying).
//
// PROCESSING PIPELINE
//
//   incoming rows (camelCase from gateway)
//        │
//        ▼  pre-validate (Issue 3 + Section 3)
//   ┌─────────────────────────────────────┐
//   │ • drop rows missing required fields │
//   │ • drop rows whose userId doesn't    │
//   │   exist in local users table        │
//   │ • drop rows failing drizzle-zod     │
//   │   validators (belt-and-suspenders)  │
//   └────────────┬────────────────────────┘
//                ▼
//   chunk into 50-row sub-batches (Issue 4A)
//                │
//                ▼
//   ┌─────────────────────────────────────────────┐
//   │  BEGIN tx                                    │
//   │   for each row in sub-batch:                 │
//   │     SELECT local lamport                     │
//   │     if incoming.lamport > local.lamport:     │
//   │       INSERT ON CONFLICT DO UPDATE (full)    │
//   │       (UPDATE, never REPLACE — cascade FKs)  │
//   │       applied.push(row.id)                   │
//   │   bump sync_state.last_pulled_lamport        │
//   │   bump sync_state.last_pushed_lamport        │
//   │     = max(current, max(incoming.lamport))    │
//   │     ← Issue 1A: keeps nextLamport() ahead    │
//   │  COMMIT                                      │
//   └────────────┬────────────────────────────────┘
//                ▼  on commit: emit IPC event
//   MEETINGS_REMOTE_APPLIED { ids: appliedIds }
//
// CONCURRENCY: applyRemote runs inside SyncPullService which already
// enforces the push/pull mutex via SyncAgent.getState(). No additional
// locking needed here.
// =============================================================================

import type Database from 'better-sqlite3'

/** Size of each sub-batch transaction. 50 keeps the IPC payload + the
 *  renderer's TanStack invalidate storm bounded; first-launch catch-up
 *  on a heavy account streams in 50-row waves. */
const CHUNK_SIZE = 50

/** Shape of a pulled meeting row (drizzle camelCase from gateway). Only
 *  fields the desktop persists are typed; others are tolerated. */
export interface PulledMeetingRow {
  id: string
  userId: string
  title: string
  date: string | Date
  durationSeconds: number | null
  calendarEventId: string | null
  meetingPlatform: string | null
  meetingUrl: string | null
  transcriptPath: string | null
  summaryPath: string | null
  recordingPath: string | null
  transcriptDriveId: string | null
  summaryDriveId: string | null
  templateId: string | null
  speakerCount: number
  speakerMap: unknown
  transcriptSegments: unknown
  notes: string | null
  // AI-generated summary markdown (migration 099). Same column the desktop
  // summarizer's dual-write fills in. Without this in the pull-side upsert,
  // mobile-generated summaries (POST /meetings/:id/enhance) reach Neon but
  // never land in desktop SQLite — the column would stay at whatever the
  // desktop wrote locally (or NULL if the desktop never summarized).
  summary: string | null
  attendees: unknown
  attendeeEmails: unknown
  chatMessages: unknown
  companies: unknown
  dismissedCompanies: unknown
  status: string
  deepgramRequestId?: string | null
  wasImpromptu: boolean
  isGroupEvent: boolean
  isGroupEventUserSet: boolean
  scheduledEndAt: string | Date | null
  createdAt: string | Date
  updatedAt: string | Date
  lamport: string
  [field: string]: unknown
}

export interface ApplyRemoteOptions {
  /** Caller can override for tests. */
  chunkSize?: number
  /** Emit IPC after each sub-batch commit. Optional so tests can spy. */
  onApplied?: (ids: string[]) => void
  /** Log surface — default is a no-op; production wires pino. */
  log?: {
    info?: (payload: Record<string, unknown>, msg: string) => void
    warn?: (payload: Record<string, unknown>, msg: string) => void
  }
}

export interface ApplyRemoteResult {
  appliedIds: string[]
  skippedLowLamport: number
  skippedPreValidation: number
}

// =============================================================================
// T14 — Generic apply helper.
//
// The orchestration (pre-validate, chunk into sub-batches, transaction,
// lamport LWW per row, bump sync_state, emit IPC) is identical across
// owned tables. Only the upsert SQL + the IPC channel name differ.
//
// Each table provides a TableSpec describing:
//   - tableName: the SQLite table being written (informational + logging)
//   - selectLamportSql: e.g. "SELECT lamport FROM notes WHERE id = ?"
//     Optional second-and-onwards params for composite PKs.
//   - rowKey(row): returns the value(s) used to lookup the local lamport,
//     in the same order as selectLamportSql binds.
//   - rowId(row): returns a stringified identifier for logging + IPC.
//   - upsert(db, row): performs the actual INSERT ON CONFLICT DO UPDATE.
//
// The helper handles the rest — including the cross-table-shared FK
// pre-validation (local user row exists) and the per-chunk transaction +
// sync_state bump (Issue 1A: both last_pulled_lamport AND
// last_pushed_lamport advance so nextLamport() seeds correctly).
// =============================================================================

export interface PulledRow {
  id: string
  userId?: string
  lamport: string
  [field: string]: unknown
}

export interface TableSpec<RowT extends PulledRow> {
  tableName: string
  /** Composite-PK SELECT: pass keys to bind in the same order as
   *  rowKey() returns them. Single-PK tables use a single binding. */
  selectLamportSql: string
  rowKey(row: RowT): unknown[]
  rowId(row: RowT): string
  upsert(db: Database.Database, row: RowT): void
  /** Optional extra row-shape validation beyond the default id+lamport
   *  check. Returns false to drop the row. */
  validate?(row: RowT): boolean
  /** True when rows carry a userId field that must match the local user.
   *  False for cascade-child tables like contact_emails / org_company_aliases. */
  hasUserId: boolean
}

/**
 * Generic apply primitive. Mechanically equivalent to applyRemoteMeetings
 * but parameterized so the other 4 owned tables (notes, contacts,
 * org_companies, contact_emails, org_company_aliases) can reuse it.
 *
 * Returns the row ids (via spec.rowId) that were actually written
 * (incoming.lamport > local.lamport). Rows with lower-or-equal lamport
 * are skipped silently.
 */
export function applyRemoteRows<RowT extends PulledRow>(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: RowT[],
  spec: TableSpec<RowT>,
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE
  const log = opts.log ?? {}
  const onApplied = opts.onApplied
  const tableName = spec.tableName

  // --- Pre-validation -------------------------------------------------------
  const validated: RowT[] = []
  let skippedPreValidation = 0

  if (spec.hasUserId) {
    // Cache the users-table lookup so we don't run a SELECT per row.
    const localUserExists = db
      .prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1')
      .get(userId)
    if (!localUserExists) {
      log.warn?.(
        { userId, tableName, metric: 'sync.pull.fk_pre_skip', count: rows.length },
        'sync.pull skipped batch — local user row missing',
      )
      return { appliedIds: [], skippedLowLamport: 0, skippedPreValidation: rows.length }
    }
  }

  for (const row of rows) {
    // Required-field check — id + lamport (+ userId when hasUserId) are
    // non-negotiable.
    if (
      typeof row?.id !== 'string' ||
      typeof row?.lamport !== 'string' ||
      (spec.hasUserId && typeof row?.userId !== 'string')
    ) {
      skippedPreValidation++
      log.warn?.(
        { tableName, metric: 'sync.pull.malformed_pre_skip', id: (row as { id?: unknown })?.id },
        'sync.pull skipped row — missing required fields',
      )
      continue
    }
    if (spec.validate && !spec.validate(row)) {
      skippedPreValidation++
      log.warn?.(
        { tableName, metric: 'sync.pull.invalid_pre_skip', id: row.id },
        'sync.pull skipped row — spec.validate rejected',
      )
      continue
    }
    validated.push(row)
  }

  // --- Chunked apply --------------------------------------------------------
  const appliedIds: string[] = []
  let skippedLowLamport = 0

  for (let i = 0; i < validated.length; i += chunkSize) {
    const chunk = validated.slice(i, i + chunkSize)
    const subBatchApplied: string[] = []
    let subBatchHighWater = 0n

    const apply = db.transaction(() => {
      const selectStmt = db.prepare(spec.selectLamportSql)
      for (const row of chunk) {
        const local = selectStmt.get(...spec.rowKey(row)) as
          | { lamport: string }
          | undefined
        const localLamport = local ? BigInt(local.lamport) : -1n
        const incomingLamport = BigInt(row.lamport)
        if (incomingLamport <= localLamport) {
          skippedLowLamport++
          continue
        }

        spec.upsert(db, row)
        subBatchApplied.push(spec.rowId(row))
        if (incomingLamport > subBatchHighWater) subBatchHighWater = incomingLamport
      }

      if (subBatchApplied.length > 0) {
        const hw = subBatchHighWater.toString()
        db.prepare(
          `INSERT INTO sync_state (device_id, user_id, last_pushed_lamport, last_pulled_lamport)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             last_pulled_lamport = CASE
               WHEN CAST(excluded.last_pulled_lamport AS INTEGER) > CAST(sync_state.last_pulled_lamport AS INTEGER)
               THEN excluded.last_pulled_lamport ELSE sync_state.last_pulled_lamport END,
             last_pushed_lamport = CASE
               WHEN CAST(excluded.last_pushed_lamport AS INTEGER) > CAST(sync_state.last_pushed_lamport AS INTEGER)
               THEN excluded.last_pushed_lamport ELSE sync_state.last_pushed_lamport END,
             last_seen_at = datetime('now')`,
        ).run(deviceId, userId, hw, hw)
      }
    })

    try {
      apply()
    } catch (err) {
      log.warn?.(
        {
          tableName,
          metric: 'sync.pull.tx_rollback',
          chunkStart: i,
          chunkSize: chunk.length,
          error: err instanceof Error ? err.message : String(err),
        },
        'sync.pull sub-batch rolled back',
      )
      continue
    }

    appliedIds.push(...subBatchApplied)
    if (subBatchApplied.length > 0) {
      onApplied?.(subBatchApplied)
      log.info?.(
        {
          tableName,
          metric: 'sync.pull.applied',
          appliedCount: subBatchApplied.length,
          highWater: subBatchHighWater.toString(),
        },
        'sync.pull applied sub-batch',
      )
    }
  }

  return { appliedIds, skippedLowLamport, skippedPreValidation }
}

/**
 * Apply pulled meeting rows to local SQLite. Returns the ids that were
 * actually written (rows where incoming.lamport > local.lamport).
 */
export function applyRemoteMeetings(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledMeetingRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, MEETINGS_SPEC, opts)
}

const MEETINGS_SPEC: TableSpec<PulledMeetingRow> = {
  tableName: 'meetings',
  hasUserId: true,
  selectLamportSql: 'SELECT lamport FROM meetings WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertMeetingRow(db, row),
}

// ─── Notes (T14) ─────────────────────────────────────────────────────────

/** Shape of a pulled note row (gateway returns drizzle camelCase). */
export interface PulledNoteRow extends PulledRow {
  id: string
  userId: string
  title: string | null
  content: string
  companyId: string | null
  contactId: string | null
  sourceMeetingId: string | null
  themeId: string | null
  isPinned: boolean
  folderPath: string | null
  importSource: string | null
  sourceDigestId: string | null
  createdByUserId: string | null
  updatedByUserId: string | null
  lamport: string
  createdAt: string | Date
  updatedAt: string | Date
}

export function applyRemoteNotes(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledNoteRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, NOTES_SPEC, opts)
}

const NOTES_SPEC: TableSpec<PulledNoteRow> = {
  tableName: 'notes',
  hasUserId: true,
  selectLamportSql: 'SELECT lamport FROM notes WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertNoteRow(db, row),
}

function upsertNoteRow(db: Database.Database, row: PulledNoteRow): void {
  // SQLite notes table has no user_id column — Postgres carries it but
  // desktop scopes via created_by_user_id. Drop userId from the upsert.
  db.prepare(
    `INSERT INTO notes (
       id, title, content,
       company_id, contact_id, source_meeting_id, theme_id,
       is_pinned, folder_path, import_source, source_digest_id,
       created_by_user_id, updated_by_user_id,
       created_at, updated_at, lamport
     ) VALUES (
       @id, @title, @content,
       @companyId, @contactId, @sourceMeetingId, @themeId,
       @isPinned, @folderPath, @importSource, @sourceDigestId,
       @createdByUserId, @updatedByUserId,
       @createdAt, @updatedAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       company_id = excluded.company_id,
       contact_id = excluded.contact_id,
       source_meeting_id = excluded.source_meeting_id,
       theme_id = excluded.theme_id,
       is_pinned = excluded.is_pinned,
       folder_path = excluded.folder_path,
       import_source = excluded.import_source,
       source_digest_id = excluded.source_digest_id,
       created_by_user_id = excluded.created_by_user_id,
       updated_by_user_id = excluded.updated_by_user_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    title: row.title,
    content: row.content,
    companyId: row.companyId,
    contactId: row.contactId,
    sourceMeetingId: row.sourceMeetingId,
    themeId: row.themeId,
    isPinned: row.isPinned ? 1 : 0,
    folderPath: row.folderPath,
    importSource: row.importSource,
    sourceDigestId: row.sourceDigestId,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lamport: row.lamport,
  })
}

// ─── Org Companies (T14) ─────────────────────────────────────────────────

/** Shape of a pulled org_companies row (gateway returns drizzle camelCase). */
export interface PulledOrgCompanyRow extends PulledRow {
  id: string
  userId: string
  canonicalName: string
  normalizedName: string
  description: string | null
  primaryDomain: string | null
  websiteUrl: string | null
  linkedinCompanyUrl: string | null
  twitterHandle: string | null
  crunchbaseUrl: string | null
  angellistUrl: string | null
  stage: string | null
  pipelineStage: string | null
  priority: string | null
  status: string
  entityType: string
  includeInCompaniesView: number
  classificationSource: string
  classificationConfidence: number | null
  industry: string | null
  crmProvider: string | null
  crmCompanyId: string | null
  city: string | null
  state: string | null
  hqAddress: string | null
  foundingYear: number | null
  employeeCountRange: string | null
  targetCustomer: string | null
  businessModel: string | null
  productStage: string | null
  revenueModel: string | null
  arr: number | null
  burnRate: number | null
  runwayMonths: number | null
  lastFundingDate: string | Date | null
  totalFundingRaised: number | null
  leadInvestor: string | null
  leadInvestorCompanyId: string | null
  coInvestors: unknown
  round: string | null
  raiseSize: number | null
  postMoneyValuation: number | null
  relationshipOwner: string | null
  dealSource: string | null
  warmIntroSource: string | null
  referralContactId: string | null
  nextFollowupDate: string | Date | null
  investmentSize: string | null
  ownershipPct: string | null
  followonInvestmentSize: string | null
  totalInvested: string | null
  investmentRound: string | null
  initialInvestmentSecurity: string | null
  dateOfInitialInvestment: string | Date | null
  initialRoundSize: number | null
  lastCompanyValuation: number | null
  followonCheck: number | null
  followonDate: string | Date | null
  followonCheck2: number | null
  followonDate2: string | Date | null
  investmentMark: number | null
  portfolioFund: string | null
  sourceType: string | null
  sourceEntityType: string | null
  sourceEntityId: string | null
  keyTakeaways: string | null
  fieldSources: unknown
  lamport: string
  createdAt: string | Date
  updatedAt: string | Date
}

export function applyRemoteOrgCompanies(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledOrgCompanyRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, ORG_COMPANIES_SPEC, opts)
}

const ORG_COMPANIES_SPEC: TableSpec<PulledOrgCompanyRow> = {
  tableName: 'org_companies',
  hasUserId: true,
  selectLamportSql: 'SELECT lamport FROM org_companies WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertOrgCompanyRow(db, row),
}

function upsertOrgCompanyRow(db: Database.Database, row: PulledOrgCompanyRow): void {
  // SQLite org_companies has no user_id column — Postgres carries it for
  // multi-tenant filtering; desktop is single-user.
  db.prepare(
    `INSERT INTO org_companies (
       id, canonical_name, normalized_name, description,
       primary_domain, website_url, linkedin_company_url, twitter_handle,
       crunchbase_url, angellist_url,
       stage, pipeline_stage, priority, status,
       entity_type, include_in_companies_view, classification_source, classification_confidence,
       industry, crm_provider, crm_company_id,
       city, state, hq_address,
       founding_year, employee_count_range,
       target_customer, business_model, product_stage, revenue_model,
       arr, burn_rate, runway_months, last_funding_date, total_funding_raised,
       lead_investor, lead_investor_company_id, co_investors,
       round, raise_size, post_money_valuation,
       relationship_owner, deal_source, warm_intro_source, referral_contact_id, next_followup_date,
       investment_size, ownership_pct, followon_investment_size, total_invested,
       investment_round, initial_investment_security, date_of_initial_investment,
       initial_round_size, last_company_valuation,
       followon_check, followon_date, followon_check_2, followon_date_2, investment_mark,
       portfolio_fund, source_type, source_entity_type, source_entity_id,
       key_takeaways, field_sources,
       created_at, updated_at, lamport
     ) VALUES (
       @id, @canonicalName, @normalizedName, @description,
       @primaryDomain, @websiteUrl, @linkedinCompanyUrl, @twitterHandle,
       @crunchbaseUrl, @angellistUrl,
       @stage, @pipelineStage, @priority, @status,
       @entityType, @includeInCompaniesView, @classificationSource, @classificationConfidence,
       @industry, @crmProvider, @crmCompanyId,
       @city, @state, @hqAddress,
       @foundingYear, @employeeCountRange,
       @targetCustomer, @businessModel, @productStage, @revenueModel,
       @arr, @burnRate, @runwayMonths, @lastFundingDate, @totalFundingRaised,
       @leadInvestor, @leadInvestorCompanyId, @coInvestors,
       @round, @raiseSize, @postMoneyValuation,
       @relationshipOwner, @dealSource, @warmIntroSource, @referralContactId, @nextFollowupDate,
       @investmentSize, @ownershipPct, @followonInvestmentSize, @totalInvested,
       @investmentRound, @initialInvestmentSecurity, @dateOfInitialInvestment,
       @initialRoundSize, @lastCompanyValuation,
       @followonCheck, @followonDate, @followonCheck2, @followonDate2, @investmentMark,
       @portfolioFund, @sourceType, @sourceEntityType, @sourceEntityId,
       @keyTakeaways, @fieldSources,
       @createdAt, @updatedAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       canonical_name = excluded.canonical_name,
       normalized_name = excluded.normalized_name,
       description = excluded.description,
       primary_domain = excluded.primary_domain,
       website_url = excluded.website_url,
       linkedin_company_url = excluded.linkedin_company_url,
       twitter_handle = excluded.twitter_handle,
       crunchbase_url = excluded.crunchbase_url,
       angellist_url = excluded.angellist_url,
       stage = excluded.stage,
       pipeline_stage = excluded.pipeline_stage,
       priority = excluded.priority,
       status = excluded.status,
       entity_type = excluded.entity_type,
       include_in_companies_view = excluded.include_in_companies_view,
       classification_source = excluded.classification_source,
       classification_confidence = excluded.classification_confidence,
       industry = excluded.industry,
       crm_provider = excluded.crm_provider,
       crm_company_id = excluded.crm_company_id,
       city = excluded.city,
       state = excluded.state,
       hq_address = excluded.hq_address,
       founding_year = excluded.founding_year,
       employee_count_range = excluded.employee_count_range,
       target_customer = excluded.target_customer,
       business_model = excluded.business_model,
       product_stage = excluded.product_stage,
       revenue_model = excluded.revenue_model,
       arr = excluded.arr,
       burn_rate = excluded.burn_rate,
       runway_months = excluded.runway_months,
       last_funding_date = excluded.last_funding_date,
       total_funding_raised = excluded.total_funding_raised,
       lead_investor = excluded.lead_investor,
       lead_investor_company_id = excluded.lead_investor_company_id,
       co_investors = excluded.co_investors,
       round = excluded.round,
       raise_size = excluded.raise_size,
       post_money_valuation = excluded.post_money_valuation,
       relationship_owner = excluded.relationship_owner,
       deal_source = excluded.deal_source,
       warm_intro_source = excluded.warm_intro_source,
       referral_contact_id = excluded.referral_contact_id,
       next_followup_date = excluded.next_followup_date,
       investment_size = excluded.investment_size,
       ownership_pct = excluded.ownership_pct,
       followon_investment_size = excluded.followon_investment_size,
       total_invested = excluded.total_invested,
       investment_round = excluded.investment_round,
       initial_investment_security = excluded.initial_investment_security,
       date_of_initial_investment = excluded.date_of_initial_investment,
       initial_round_size = excluded.initial_round_size,
       last_company_valuation = excluded.last_company_valuation,
       followon_check = excluded.followon_check,
       followon_date = excluded.followon_date,
       followon_check_2 = excluded.followon_check_2,
       followon_date_2 = excluded.followon_date_2,
       investment_mark = excluded.investment_mark,
       portfolio_fund = excluded.portfolio_fund,
       source_type = excluded.source_type,
       source_entity_type = excluded.source_entity_type,
       source_entity_id = excluded.source_entity_id,
       key_takeaways = excluded.key_takeaways,
       field_sources = excluded.field_sources,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    canonicalName: row.canonicalName,
    normalizedName: row.normalizedName,
    description: row.description,
    primaryDomain: row.primaryDomain,
    websiteUrl: row.websiteUrl,
    linkedinCompanyUrl: row.linkedinCompanyUrl,
    twitterHandle: row.twitterHandle,
    crunchbaseUrl: row.crunchbaseUrl,
    angellistUrl: row.angellistUrl,
    stage: row.stage,
    pipelineStage: row.pipelineStage,
    priority: row.priority,
    status: row.status,
    entityType: row.entityType,
    includeInCompaniesView: row.includeInCompaniesView,
    classificationSource: row.classificationSource,
    classificationConfidence: row.classificationConfidence,
    industry: row.industry,
    crmProvider: row.crmProvider,
    crmCompanyId: row.crmCompanyId,
    city: row.city,
    state: row.state,
    hqAddress: row.hqAddress,
    foundingYear: row.foundingYear,
    employeeCountRange: row.employeeCountRange,
    targetCustomer: row.targetCustomer,
    businessModel: row.businessModel,
    productStage: row.productStage,
    revenueModel: row.revenueModel,
    arr: row.arr,
    burnRate: row.burnRate,
    runwayMonths: row.runwayMonths,
    lastFundingDate: row.lastFundingDate ? toIso(row.lastFundingDate) : null,
    totalFundingRaised: row.totalFundingRaised,
    leadInvestor: row.leadInvestor,
    leadInvestorCompanyId: row.leadInvestorCompanyId,
    coInvestors: stringify(row.coInvestors),
    round: row.round,
    raiseSize: row.raiseSize,
    postMoneyValuation: row.postMoneyValuation,
    relationshipOwner: row.relationshipOwner,
    dealSource: row.dealSource,
    warmIntroSource: row.warmIntroSource,
    referralContactId: row.referralContactId,
    nextFollowupDate: row.nextFollowupDate ? toIso(row.nextFollowupDate) : null,
    investmentSize: row.investmentSize,
    ownershipPct: row.ownershipPct,
    followonInvestmentSize: row.followonInvestmentSize,
    totalInvested: row.totalInvested,
    investmentRound: row.investmentRound,
    initialInvestmentSecurity: row.initialInvestmentSecurity,
    dateOfInitialInvestment: row.dateOfInitialInvestment ? toIso(row.dateOfInitialInvestment) : null,
    initialRoundSize: row.initialRoundSize,
    lastCompanyValuation: row.lastCompanyValuation,
    followonCheck: row.followonCheck,
    followonDate: row.followonDate ? toIso(row.followonDate) : null,
    followonCheck2: row.followonCheck2,
    followonDate2: row.followonDate2 ? toIso(row.followonDate2) : null,
    investmentMark: row.investmentMark,
    portfolioFund: row.portfolioFund,
    sourceType: row.sourceType,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    keyTakeaways: row.keyTakeaways,
    fieldSources: stringify(row.fieldSources),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lamport: row.lamport,
  })
}

// ─── Org Company Aliases (T14) ───────────────────────────────────────────

export interface PulledOrgCompanyAliasRow extends PulledRow {
  id: string
  companyId: string
  aliasValue: string
  aliasType: string
  lamport: string
  createdAt: string | Date
}

export function applyRemoteOrgCompanyAliases(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledOrgCompanyAliasRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, ORG_COMPANY_ALIASES_SPEC, opts)
}

const ORG_COMPANY_ALIASES_SPEC: TableSpec<PulledOrgCompanyAliasRow> = {
  tableName: 'org_company_aliases',
  // No user_id on this cascade-child table — scoping derives from parent
  // org_companies.user_id. Local user existence is checked elsewhere.
  hasUserId: false,
  selectLamportSql: 'SELECT lamport FROM org_company_aliases WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertOrgCompanyAliasRow(db, row),
}

function upsertOrgCompanyAliasRow(
  db: Database.Database,
  row: PulledOrgCompanyAliasRow,
): void {
  db.prepare(
    `INSERT INTO org_company_aliases (
       id, company_id, alias_value, alias_type, created_at, lamport
     ) VALUES (
       @id, @companyId, @aliasValue, @aliasType, @createdAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       company_id = excluded.company_id,
       alias_value = excluded.alias_value,
       alias_type = excluded.alias_type,
       created_at = excluded.created_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    companyId: row.companyId,
    aliasValue: row.aliasValue,
    aliasType: row.aliasType,
    createdAt: toIso(row.createdAt),
    lamport: row.lamport,
  })
}

// ─── Contacts (T14) ──────────────────────────────────────────────────────

export interface PulledContactRow extends PulledRow {
  id: string
  userId: string
  fullName: string
  firstName: string | null
  lastName: string | null
  normalizedName: string
  email: string | null
  phone: string | null
  primaryCompanyId: string | null
  title: string | null
  contactType: string | null
  linkedinUrl: string | null
  crmContactId: string | null
  crmProvider: string | null
  twitterHandle: string | null
  otherSocials: unknown
  city: string | null
  state: string | null
  timezone: string | null
  pronouns: string | null
  birthday: string | null
  university: string | null
  previousCompanies: unknown
  workHistory: unknown
  educationHistory: unknown
  tags: unknown
  relationshipStrength: string | null
  lastMetEvent: string | null
  warmIntroPath: string | null
  investorStage: string | null
  fundSize: number | null
  typicalCheckSizeMin: number | null
  typicalCheckSizeMax: number | null
  investmentStageFocus: unknown
  investmentSectorFocus: unknown
  investmentSectorFocusNotes: string | null
  proudPortfolioCompanies: unknown
  linkedinHeadline: string | null
  linkedinSkills: unknown
  linkedinEnrichedAt: string | Date | null
  talentPipeline: string | null
  keyTakeaways: string | null
  fieldSources: unknown
  notes: string | null
  lastMeetingAt: string | Date | null
  lastEmailAt: string | Date | null
  lamport: string
  createdAt: string | Date
  updatedAt: string | Date
}

export function applyRemoteContacts(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledContactRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, CONTACTS_SPEC, opts)
}

const CONTACTS_SPEC: TableSpec<PulledContactRow> = {
  tableName: 'contacts',
  hasUserId: true,
  selectLamportSql: 'SELECT lamport FROM contacts WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertContactRow(db, row),
}

function upsertContactRow(db: Database.Database, row: PulledContactRow): void {
  // SQLite contacts has no user_id column.
  db.prepare(
    `INSERT INTO contacts (
       id, full_name, first_name, last_name, normalized_name,
       email, phone,
       primary_company_id, title, contact_type,
       linkedin_url, crm_contact_id, crm_provider, twitter_handle, other_socials,
       city, state, timezone, pronouns, birthday,
       university, previous_companies, work_history, education_history,
       tags, relationship_strength, last_met_event, warm_intro_path,
       investor_stage, fund_size, typical_check_size_min, typical_check_size_max,
       investment_stage_focus, investment_sector_focus, investment_sector_focus_notes,
       proud_portfolio_companies, linkedin_headline, linkedin_skills, linkedin_enriched_at,
       talent_pipeline, key_takeaways, field_sources, notes,
       last_meeting_at, last_email_at,
       created_at, updated_at, lamport
     ) VALUES (
       @id, @fullName, @firstName, @lastName, @normalizedName,
       @email, @phone,
       @primaryCompanyId, @title, @contactType,
       @linkedinUrl, @crmContactId, @crmProvider, @twitterHandle, @otherSocials,
       @city, @state, @timezone, @pronouns, @birthday,
       @university, @previousCompanies, @workHistory, @educationHistory,
       @tags, @relationshipStrength, @lastMetEvent, @warmIntroPath,
       @investorStage, @fundSize, @typicalCheckSizeMin, @typicalCheckSizeMax,
       @investmentStageFocus, @investmentSectorFocus, @investmentSectorFocusNotes,
       @proudPortfolioCompanies, @linkedinHeadline, @linkedinSkills, @linkedinEnrichedAt,
       @talentPipeline, @keyTakeaways, @fieldSources, @notes,
       @lastMeetingAt, @lastEmailAt,
       @createdAt, @updatedAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       full_name = excluded.full_name,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       normalized_name = excluded.normalized_name,
       email = excluded.email,
       phone = excluded.phone,
       primary_company_id = excluded.primary_company_id,
       title = excluded.title,
       contact_type = excluded.contact_type,
       linkedin_url = excluded.linkedin_url,
       crm_contact_id = excluded.crm_contact_id,
       crm_provider = excluded.crm_provider,
       twitter_handle = excluded.twitter_handle,
       other_socials = excluded.other_socials,
       city = excluded.city,
       state = excluded.state,
       timezone = excluded.timezone,
       pronouns = excluded.pronouns,
       birthday = excluded.birthday,
       university = excluded.university,
       previous_companies = excluded.previous_companies,
       work_history = excluded.work_history,
       education_history = excluded.education_history,
       tags = excluded.tags,
       relationship_strength = excluded.relationship_strength,
       last_met_event = excluded.last_met_event,
       warm_intro_path = excluded.warm_intro_path,
       investor_stage = excluded.investor_stage,
       fund_size = excluded.fund_size,
       typical_check_size_min = excluded.typical_check_size_min,
       typical_check_size_max = excluded.typical_check_size_max,
       investment_stage_focus = excluded.investment_stage_focus,
       investment_sector_focus = excluded.investment_sector_focus,
       investment_sector_focus_notes = excluded.investment_sector_focus_notes,
       proud_portfolio_companies = excluded.proud_portfolio_companies,
       linkedin_headline = excluded.linkedin_headline,
       linkedin_skills = excluded.linkedin_skills,
       linkedin_enriched_at = excluded.linkedin_enriched_at,
       talent_pipeline = excluded.talent_pipeline,
       key_takeaways = excluded.key_takeaways,
       field_sources = excluded.field_sources,
       notes = excluded.notes,
       last_meeting_at = excluded.last_meeting_at,
       last_email_at = excluded.last_email_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    normalizedName: row.normalizedName,
    email: row.email,
    phone: row.phone,
    primaryCompanyId: row.primaryCompanyId,
    title: row.title,
    contactType: row.contactType,
    linkedinUrl: row.linkedinUrl,
    crmContactId: row.crmContactId,
    crmProvider: row.crmProvider,
    twitterHandle: row.twitterHandle,
    otherSocials: stringify(row.otherSocials),
    city: row.city,
    state: row.state,
    timezone: row.timezone,
    pronouns: row.pronouns,
    birthday: row.birthday,
    university: row.university,
    previousCompanies: stringify(row.previousCompanies),
    workHistory: stringify(row.workHistory),
    educationHistory: stringify(row.educationHistory),
    tags: stringify(row.tags),
    relationshipStrength: row.relationshipStrength,
    lastMetEvent: row.lastMetEvent,
    warmIntroPath: row.warmIntroPath,
    investorStage: row.investorStage,
    fundSize: row.fundSize,
    typicalCheckSizeMin: row.typicalCheckSizeMin,
    typicalCheckSizeMax: row.typicalCheckSizeMax,
    investmentStageFocus: stringify(row.investmentStageFocus),
    investmentSectorFocus: stringify(row.investmentSectorFocus),
    investmentSectorFocusNotes: row.investmentSectorFocusNotes,
    proudPortfolioCompanies: stringify(row.proudPortfolioCompanies),
    linkedinHeadline: row.linkedinHeadline,
    linkedinSkills: stringify(row.linkedinSkills),
    linkedinEnrichedAt: row.linkedinEnrichedAt ? toIso(row.linkedinEnrichedAt) : null,
    talentPipeline: row.talentPipeline,
    keyTakeaways: row.keyTakeaways,
    fieldSources: stringify(row.fieldSources),
    notes: row.notes,
    lastMeetingAt: row.lastMeetingAt ? toIso(row.lastMeetingAt) : null,
    lastEmailAt: row.lastEmailAt ? toIso(row.lastEmailAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lamport: row.lamport,
  })
}

// ─── Contact Emails (T14) ────────────────────────────────────────────────

/** Wire shape — composite PK (contactId, email); gateway sends no `id`. */
export interface PulledContactEmailRowWire {
  contactId: string
  email: string
  isPrimary: number
  lamport: string
  createdAt: string | Date
}

interface PulledContactEmailRow extends PulledRow {
  id: string
  contactId: string
  email: string
  isPrimary: number
  lamport: string
  createdAt: string | Date
}

export function applyRemoteContactEmails(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledContactEmailRowWire[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  // Synthesise the id for log + IPC use. Gateway doesn't include one (the
  // PK is composite on the wire) so we add it before passing through.
  const stamped: PulledContactEmailRow[] = rows.map((r) => ({
    ...r,
    id: `${r.contactId}:${r.email}`,
  }))
  return applyRemoteRows(db, deviceId, userId, stamped, CONTACT_EMAILS_SPEC, opts)
}

const CONTACT_EMAILS_SPEC: TableSpec<PulledContactEmailRow> = {
  tableName: 'contact_emails',
  hasUserId: false,
  selectLamportSql:
    'SELECT lamport FROM contact_emails WHERE contact_id = ? AND email = ?',
  rowKey: (row) => [row.contactId, row.email],
  rowId: (row) => `${row.contactId}:${row.email}`,
  upsert: (db, row) => upsertContactEmailRow(db, row),
}

function upsertContactEmailRow(
  db: Database.Database,
  row: PulledContactEmailRow,
): void {
  db.prepare(
    `INSERT INTO contact_emails (
       contact_id, email, is_primary, created_at, lamport
     ) VALUES (
       @contactId, @email, @isPrimary, @createdAt, @lamport
     )
     ON CONFLICT(contact_id, email) DO UPDATE SET
       is_primary = excluded.is_primary,
       created_at = excluded.created_at,
       lamport = excluded.lamport`,
  ).run({
    contactId: row.contactId,
    email: row.email,
    isPrimary: row.isPrimary ? 1 : 0,
    createdAt: toIso(row.createdAt),
    lamport: row.lamport,
  })
}

// ─── Chat Sessions (2026-05-24, Bug B) ──────────────────────────────────────

/** Wire shape — gateway sends drizzle camelCase. SQLite has no
 *  citations column on chat_sessions so we ignore extras. */
export interface PulledChatSessionRow extends PulledRow {
  id: string
  userId: string
  contextKind: string
  contextId: string
  contextLabel: string | null
  title: string | null
  previewText: string | null
  messageCount: number
  isActive: number | boolean
  isPinned: number | boolean
  isArchived: number | boolean
  cacheEnabled: number | boolean
  lastMessageAt: string | Date
  createdByUserId: string | null
  updatedByUserId: string | null
  lamport: string
  createdAt: string | Date
  updatedAt: string | Date
}

export function applyRemoteChatSessions(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledChatSessionRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, CHAT_SESSIONS_SPEC, opts)
}

const CHAT_SESSIONS_SPEC: TableSpec<PulledChatSessionRow> = {
  tableName: 'chat_sessions',
  hasUserId: true,
  selectLamportSql: 'SELECT lamport FROM chat_sessions WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertChatSessionRow(db, row),
}

function upsertChatSessionRow(
  db: Database.Database,
  row: PulledChatSessionRow,
): void {
  // SQLite chat_sessions has no user_id column — Postgres carries it
  // for multi-tenant filtering; desktop is single-user.
  // Boolean → integer-flag conversion for the SQLite columns.
  const intFlag = (v: number | boolean): number =>
    typeof v === 'boolean' ? (v ? 1 : 0) : v
  db.prepare(
    `INSERT INTO chat_sessions (
       id, context_id, context_kind, context_label,
       title, preview_text, message_count,
       is_active, is_pinned, is_archived, cache_enabled,
       last_message_at, created_at, updated_at,
       created_by_user_id, updated_by_user_id, lamport
     ) VALUES (
       @id, @contextId, @contextKind, @contextLabel,
       @title, @previewText, @messageCount,
       @isActive, @isPinned, @isArchived, @cacheEnabled,
       @lastMessageAt, @createdAt, @updatedAt,
       @createdByUserId, @updatedByUserId, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       context_id = excluded.context_id,
       context_kind = excluded.context_kind,
       context_label = excluded.context_label,
       title = excluded.title,
       preview_text = excluded.preview_text,
       message_count = excluded.message_count,
       is_active = excluded.is_active,
       is_pinned = excluded.is_pinned,
       is_archived = excluded.is_archived,
       cache_enabled = excluded.cache_enabled,
       last_message_at = excluded.last_message_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       updated_by_user_id = excluded.updated_by_user_id,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    contextId: row.contextId,
    contextKind: row.contextKind,
    contextLabel: row.contextLabel,
    title: row.title,
    previewText: row.previewText,
    messageCount: row.messageCount,
    isActive: intFlag(row.isActive),
    isPinned: intFlag(row.isPinned),
    isArchived: intFlag(row.isArchived),
    // Default to 1 (on) when the gateway pre-migration sends rows without
    // the field; same intent as the SQLite column default.
    cacheEnabled: intFlag(row.cacheEnabled ?? true),
    lastMessageAt: toIso(row.lastMessageAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    lamport: row.lamport,
  })
}

// ─── Chat Session Messages (2026-05-24, Bug B) ──────────────────────────────

/** Wire shape — gateway sends drizzle camelCase with citations etc.
 *  SQLite has no citations column; we drop it during upsert. */
export interface PulledChatSessionMessageRow extends PulledRow {
  id: string
  sessionId: string
  role: string
  content: string
  attachmentsJson: unknown
  createdAt: string | Date
  lamport: string
}

export function applyRemoteChatSessionMessages(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledChatSessionMessageRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  return applyRemoteRows(db, deviceId, userId, rows, CHAT_SESSION_MESSAGES_SPEC, opts)
}

const CHAT_SESSION_MESSAGES_SPEC: TableSpec<PulledChatSessionMessageRow> = {
  tableName: 'chat_session_messages',
  // No user_id column on the messages table — ownership derives from
  // the parent chat_sessions row (same as contact_emails posture).
  hasUserId: false,
  selectLamportSql: 'SELECT lamport FROM chat_session_messages WHERE id = ?',
  rowKey: (row) => [row.id],
  rowId: (row) => row.id,
  upsert: (db, row) => upsertChatSessionMessageRow(db, row),
}

function upsertChatSessionMessageRow(
  db: Database.Database,
  row: PulledChatSessionMessageRow,
): void {
  db.prepare(
    `INSERT INTO chat_session_messages (
       id, session_id, role, content, attachments_json, created_at, lamport
     ) VALUES (
       @id, @sessionId, @role, @content, @attachmentsJson, @createdAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       role = excluded.role,
       content = excluded.content,
       attachments_json = excluded.attachments_json,
       created_at = excluded.created_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    attachmentsJson: stringify(row.attachmentsJson),
    createdAt: toIso(row.createdAt),
    lamport: row.lamport,
  })
}

// ─── Upsert helper ───────────────────────────────────────────────────────────

function upsertMeetingRow(db: Database.Database, row: PulledMeetingRow): void {
  // Hand-rolled camelCase → snake_case mapping. The set of columns is
  // stable; adding a future column means adding it here too. Explicit over
  // clever — matches the project's "no magic" sync convention.
  db.prepare(
    `INSERT INTO meetings (
       id, title, date, duration_seconds, calendar_event_id,
       meeting_platform, meeting_url,
       transcript_path, summary_path, recording_path,
       transcript_drive_id, summary_drive_id,
       template_id,
       speaker_count, speaker_map, transcript_segments,
       notes, summary,
       attendees, attendee_emails, chat_messages,
       companies, dismissed_companies,
       status, was_impromptu, is_group_event, is_group_event_user_set,
       scheduled_end_at,
       created_at, updated_at, lamport
     ) VALUES (
       @id, @title, @date, @durationSeconds, @calendarEventId,
       @meetingPlatform, @meetingUrl,
       @transcriptPath, @summaryPath, @recordingPath,
       @transcriptDriveId, @summaryDriveId,
       @templateId,
       @speakerCount, @speakerMap, @transcriptSegments,
       @notes, @summary,
       @attendees, @attendeeEmails, @chatMessages,
       @companies, @dismissedCompanies,
       @status, @wasImpromptu, @isGroupEvent, @isGroupEventUserSet,
       @scheduledEndAt,
       @createdAt, @updatedAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       date = excluded.date,
       duration_seconds = excluded.duration_seconds,
       calendar_event_id = excluded.calendar_event_id,
       meeting_platform = excluded.meeting_platform,
       meeting_url = excluded.meeting_url,
       transcript_path = excluded.transcript_path,
       summary_path = excluded.summary_path,
       recording_path = excluded.recording_path,
       transcript_drive_id = excluded.transcript_drive_id,
       summary_drive_id = excluded.summary_drive_id,
       template_id = excluded.template_id,
       speaker_count = excluded.speaker_count,
       speaker_map = excluded.speaker_map,
       -- COALESCE so null on the wire = "preserve local". The gateway
       -- suppresses transcript_segments for in-progress meetings on
       -- /sync/pull (see api-gateway/src/routes/sync.ts
       -- MEETING_IN_PROGRESS_STATUSES). Without this guard, a cross-device
       -- metadata bump (calendar sync, stale-sweeper, mobile PATCH on
       -- title/attendees) while a meeting is mid-recording would ship a
       -- pull row with lamport > local_lamport AND transcript_segments=null,
       -- silently clobbering the desktop's live transcript.
       transcript_segments = COALESCE(excluded.transcript_segments, meetings.transcript_segments),
       notes = excluded.notes,
       summary = excluded.summary,
       attendees = excluded.attendees,
       attendee_emails = excluded.attendee_emails,
       chat_messages = excluded.chat_messages,
       companies = excluded.companies,
       dismissed_companies = excluded.dismissed_companies,
       status = excluded.status,
       was_impromptu = excluded.was_impromptu,
       is_group_event = excluded.is_group_event,
       is_group_event_user_set = excluded.is_group_event_user_set,
       scheduled_end_at = excluded.scheduled_end_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    title: row.title,
    date: toIso(row.date),
    durationSeconds: row.durationSeconds,
    calendarEventId: row.calendarEventId,
    meetingPlatform: row.meetingPlatform,
    meetingUrl: row.meetingUrl,
    transcriptPath: row.transcriptPath,
    summaryPath: row.summaryPath,
    recordingPath: row.recordingPath,
    transcriptDriveId: row.transcriptDriveId,
    summaryDriveId: row.summaryDriveId,
    templateId: row.templateId,
    speakerCount: row.speakerCount,
    speakerMap: stringify(row.speakerMap),
    transcriptSegments: stringify(row.transcriptSegments),
    notes: row.notes,
    summary: row.summary,
    attendees: stringify(row.attendees),
    attendeeEmails: stringify(row.attendeeEmails),
    chatMessages: stringify(row.chatMessages),
    companies: stringify(row.companies),
    dismissedCompanies: stringify(row.dismissedCompanies),
    status: row.status,
    wasImpromptu: row.wasImpromptu ? 1 : 0,
    isGroupEvent: row.isGroupEvent ? 1 : 0,
    isGroupEventUserSet: row.isGroupEventUserSet ? 1 : 0,
    scheduledEndAt: row.scheduledEndAt ? toIso(row.scheduledEndAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lamport: row.lamport,
  })
}

function toIso(v: string | Date): string {
  if (typeof v === 'string') return v
  return v.toISOString()
}

function stringify(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
