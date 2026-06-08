import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { contacts } from './contacts'

// =============================================================================
// COMPANIES — org_companies + variants. Consolidates source migrations:
//   008/012 (initial + CompanyOS core), 013 (email/domain), 014 (artifacts),
//   017 (memo — separate domain), 018 (thesis), 020 (classification),
//   021 (domain normalization — repair script), 028 (location), 029 (pipeline
//   columns), 035 (flagged_files — security-critical), 037 (extra_fields),
//   044 (decision_logs), 045 (portfolio fields), 050 (field_sources),
//   056 (new_fields), 066 (linkedin), 070 (key_takeaways), 072 (portfolio_fund),
//   073 (portfolio investment fields), 075 (investors.position),
//   076 (lead_investor_company_id), 077 (industry — repair), 083 (mime_type).
//
// Forward FK from contacts.primary_company_id → org_companies.id wired here.
// Forward FK from meetings.meeting_company_links.company_id → org_companies.id wired here.
// =============================================================================

export const orgCompanies = pgTable(
  'org_companies',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Identity
    canonicalName: text('canonical_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description'),
    primaryDomain: text('primary_domain'),
    websiteUrl: text('website_url'),
    linkedinCompanyUrl: text('linkedin_company_url'),
    twitterHandle: text('twitter_handle'),
    crunchbaseUrl: text('crunchbase_url'),
    angellistUrl: text('angellist_url'),
    // Stage / classification (migration 020)
    stage: varchar('stage', { length: 64 }),
    pipelineStage: varchar('pipeline_stage', { length: 64 }),
    // Pre-Pass stage capture (migration 0021 / SQLite 105). Holds the stage the
    // deal was in immediately before being moved to Pass; cleared on re-open.
    passedFromStage: varchar('passed_from_stage', { length: 64 }),
    priority: varchar('priority', { length: 32 }),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    entityType: varchar('entity_type', { length: 32 }).notNull().default('unknown'),
    includeInCompaniesView: integer('include_in_companies_view').notNull().default(0),
    classificationSource: varchar('classification_source', { length: 32 }).notNull().default('auto'),
    classificationConfidence: doublePrecision('classification_confidence'),
    industry: text('industry'),
    // CRM identity
    crmProvider: varchar('crm_provider', { length: 32 }),
    crmCompanyId: text('crm_company_id'),
    // Location (migration 028)
    city: text('city'),
    state: text('state'),
    hqAddress: text('hq_address'),
    // Company snapshot
    foundingYear: integer('founding_year'),
    employeeCountRange: varchar('employee_count_range', { length: 32 }),
    targetCustomer: text('target_customer'),
    businessModel: text('business_model'),
    productStage: text('product_stage'),
    revenueModel: text('revenue_model'),
    // Investment-thesis fit (single-select stage + multi-select sector CSV)
    targetInvestmentStage: text('target_investment_stage'),
    targetInvestmentSector: text('target_investment_sector'),
    // Financials
    arr: doublePrecision('arr'),
    burnRate: doublePrecision('burn_rate'),
    runwayMonths: integer('runway_months'),
    lastFundingDate: timestamp('last_funding_date', { withTimezone: true }),
    totalFundingRaised: doublePrecision('total_funding_raised'),
    leadInvestor: text('lead_investor'),
    leadInvestorCompanyId: text('lead_investor_company_id'), // self-ref FK added after table
    coInvestors: jsonb('co_investors'),
    // Round being considered
    round: varchar('round', { length: 64 }),
    raiseSize: doublePrecision('raise_size'),
    postMoneyValuation: doublePrecision('post_money_valuation'),
    // Deal flow
    relationshipOwner: text('relationship_owner'),
    dealSource: text('deal_source'),
    warmIntroSource: text('warm_intro_source'),
    referralContactId: text('referral_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    nextFollowupDate: timestamp('next_followup_date', { withTimezone: true }),
    // Investment (when we've decided to invest)
    investmentSize: text('investment_size'),
    ownershipPct: text('ownership_pct'),
    followonInvestmentSize: text('followon_investment_size'),
    totalInvested: text('total_invested'),
    investmentRound: varchar('investment_round', { length: 64 }),
    initialInvestmentSecurity: text('initial_investment_security'),
    dateOfInitialInvestment: timestamp('date_of_initial_investment', { withTimezone: true }),
    initialRoundSize: doublePrecision('initial_round_size'),
    lastCompanyValuation: doublePrecision('last_company_valuation'),
    // Follow-ons (migration 073)
    followonCheck: doublePrecision('followon_check'),
    followonDate: timestamp('followon_date', { withTimezone: true }),
    followonCheck2: doublePrecision('followon_check_2'),
    followonDate2: timestamp('followon_date_2', { withTimezone: true }),
    investmentMark: doublePrecision('investment_mark'),
    // Portfolio fund tracking (migration 072)
    portfolioFund: varchar('portfolio_fund', { length: 64 }),
    // Source tracking (where this company entered the CRM)
    sourceType: varchar('source_type', { length: 32 }),
    sourceEntityType: varchar('source_entity_type', { length: 32 }),
    sourceEntityId: text('source_entity_id'),
    // AI takeaways (migration 070)
    keyTakeaways: text('key_takeaways'),
    // User-authored note pinned to the top of the Key Takeaways card (migration 109).
    // Survives AI regeneration; passed to the LLM as known truth.
    keyTakeawaysUserNote: text('key_takeaways_user_note'),
    // Per-field source tracking (migration 050)
    fieldSources: jsonb('field_sources'),
    // Audit + sync
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('org_companies_user_idx').on(t.userId),
    uniqueIndex('org_companies_normalized_name_idx').on(t.normalizedName),
    index('org_companies_domain_idx').on(t.primaryDomain),
    index('org_companies_status_idx').on(t.status),
    index('org_companies_entity_type_idx').on(t.entityType),
    index('org_companies_include_view_idx').on(t.includeInCompaniesView),
    index('org_companies_pipeline_idx').on(t.pipelineStage),
    index('org_companies_priority_idx').on(t.priority),
    index('org_companies_portfolio_fund_idx').on(t.portfolioFund),
    check(
      'org_companies_classification_confidence_range',
      sql`${t.classificationConfidence} IS NULL OR (${t.classificationConfidence} >= 0 AND ${t.classificationConfidence} <= 1)`,
    ),
  ],
)

// Alternate company names (migration 008/012). Used for fuzzy matching against
// email signatures, calendar attendees, etc.
export const orgCompanyAliases = pgTable(
  'org_company_aliases',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    aliasValue: text('alias_value').notNull(),
    aliasType: varchar('alias_type', { length: 32 }).notNull(),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('org_company_aliases_company_type_value_idx').on(t.companyId, t.aliasType, t.aliasValue),
    index('org_company_aliases_value_idx').on(t.aliasValue),
    // SQLite version uses COLLATE NOCASE for case-insensitive matching. Postgres
    // uses lower(alias_value) instead — simpler and faster than ILIKE for indexed lookups.
    index('org_company_aliases_type_value_lower_idx')
      .on(t.aliasType, sql`lower(${t.aliasValue})`),
  ],
)

// Company ↔ Contact join (migration 012/014). One contact can be the primary contact
// for a company. is_primary maintained by application logic (mirroring contact_emails
// pattern but simpler — just one boolean, no triggers).
export const orgCompanyContacts = pgTable(
  'org_company_contacts',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    roleLabel: text('role_label'),
    isPrimary: integer('is_primary').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.contactId] }),
    // At most one primary contact per company.
    uniqueIndex('org_company_contacts_single_primary_idx')
      .on(t.companyId)
      .where(sql`${t.isPrimary} = 1`),
  ],
)

// Self-referential M2M: company X is invested in by companies Y, Z (migrations 014, 075).
// position used for stable ordering ("lead investor first" UX).
export const companyInvestors = pgTable(
  'company_investors',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    investorCompanyId: text('investor_company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    investorType: varchar('investor_type', { length: 32 }).notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('company_investors_company_idx').on(t.companyId),
    index('company_investors_investor_idx').on(t.investorCompanyId),
    index('company_investors_position_idx').on(t.companyId, t.investorType, t.position),
  ],
)

// Investment decision log (migration 044). Captures IC outcomes and follow-up
// commitments. Parallel structure to contact_decision_logs.
export const companyDecisionLogs = pgTable(
  'company_decision_logs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    decisionType: varchar('decision_type', { length: 64 }).notNull(),
    decisionDate: timestamp('decision_date', { withTimezone: true }).notNull(),
    decisionOwner: text('decision_owner'),
    amountApproved: text('amount_approved'),
    targetOwnership: text('target_ownership'),
    moreIfPossible: integer('more_if_possible').notNull().default(0),
    structure: text('structure'),
    rationaleJson: jsonb('rationale_json').notNull().default([]),
    dependenciesJson: jsonb('dependencies_json').notNull().default([]),
    nextStepsJson: jsonb('next_steps_json').notNull().default([]),
    linkedArtifactsJson: jsonb('linked_artifacts_json').notNull().default([]),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('company_decision_logs_company_idx').on(t.companyId),
    index('company_decision_logs_date_idx').on(t.companyId, sql`${t.decisionDate} DESC`),
  ],
)

// Flagged files (migration 035, 083). Security-critical — referenced by the
// PR2 capability-scoped file IPC (FILE_READ_BY_FLAGGED_ID). Each row authorizes
// the renderer to read one specific file by ID, scoped to its company.
//
// NOTE: not user-scoped here because file_id is a Google Drive resource ID — the
// Drive-level ACL is the actual security boundary. user_id added for sync ownership.
export const companyFlaggedFiles = pgTable(
  'company_flagged_files',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }).notNull(),
    // Phase 3 — pre-extracted text + extraction queue state. Desktop's
    // background worker fills extractedText at flag time so gateway-side
    // chat context builders can read the text without doing the parse on
    // every chat send. drizzle-zod auto-derives the sync validator from
    // these columns.
    extractedText: text('extracted_text'),
    extractedTextChars: integer('extracted_text_chars'),
    driveVersion: text('drive_version'),
    flaggedByUserId: text('flagged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    extractionStatus: text('extraction_status').notNull().default('pending'),
    extractionError: text('extraction_error'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    lamport: text('lamport').notNull().default('0'),
  },
  (t) => [
    uniqueIndex('company_flagged_files_company_file_idx').on(t.companyId, t.fileId),
  ],
)
