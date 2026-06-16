// Tests for the T14 expansion of the Phase 1.5c pull-side apply primitive.
// Covers: applyRemoteOrgCompanies, applyRemoteOrgCompanyAliases,
// applyRemoteContacts, applyRemoteContactEmails.
//
// Like sync-remote-apply.test.ts, builds a minimal in-memory SQLite with
// just enough schema (the columns each apply function writes) — no need
// to run the full 097-migration stack.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRemoteOrgCompanies,
  applyRemoteOrgCompanyAliases,
  applyRemoteContacts,
  applyRemoteContactEmails,
  applyRemoteChatSessions,
  applyRemoteChatSessionMessages,
  applyRemoteUserPreferences,
  type PulledOrgCompanyRow,
  type PulledOrgCompanyAliasRow,
  type PulledContactRow,
  type PulledContactEmailRowWire,
  type PulledChatSessionRow,
  type PulledChatSessionMessageRow,
  type PulledUserPreferenceRowWire,
} from '@main/services/sync-remote-apply'

const DEVICE_ID = 'device-test-1'
const USER_ID = 'user-test-1'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- org_companies: subset of the production columns the upsert touches.
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      description TEXT,
      primary_domain TEXT,
      website_url TEXT,
      linkedin_company_url TEXT,
      twitter_handle TEXT,
      crunchbase_url TEXT,
      angellist_url TEXT,
      stage TEXT,
      pipeline_stage TEXT,
      priority TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      include_in_companies_view INTEGER NOT NULL DEFAULT 0,
      classification_source TEXT NOT NULL DEFAULT 'auto',
      classification_confidence REAL,
      industry TEXT,
      crm_provider TEXT,
      crm_company_id TEXT,
      city TEXT,
      state TEXT,
      hq_address TEXT,
      founding_year INTEGER,
      employee_count_range TEXT,
      target_customer TEXT,
      business_model TEXT,
      product_stage TEXT,
      revenue_model TEXT,
      target_investment_stage TEXT,
      target_investment_sector TEXT,
      arr REAL,
      burn_rate REAL,
      runway_months INTEGER,
      last_funding_date TEXT,
      total_funding_raised REAL,
      lead_investor TEXT,
      lead_investor_company_id TEXT,
      co_investors TEXT,
      round TEXT,
      raise_size REAL,
      post_money_valuation REAL,
      relationship_owner TEXT,
      deal_source TEXT,
      warm_intro_source TEXT,
      referral_contact_id TEXT,
      next_followup_date TEXT,
      investment_size TEXT,
      ownership_pct TEXT,
      followon_investment_size TEXT,
      total_invested TEXT,
      investment_round TEXT,
      initial_investment_security TEXT,
      date_of_initial_investment TEXT,
      initial_round_size REAL,
      last_company_valuation REAL,
      followon_check REAL,
      followon_date TEXT,
      followon_check_2 REAL,
      followon_date_2 TEXT,
      investment_mark REAL,
      portfolio_fund TEXT,
      source_type TEXT,
      source_entity_type TEXT,
      source_entity_id TEXT,
      key_takeaways TEXT,
      field_sources TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      field_lamports TEXT,
      deleted_at TEXT,
      deleted_by_user_id TEXT
    );

    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      normalized_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      primary_company_id TEXT,
      title TEXT,
      contact_type TEXT,
      linkedin_url TEXT,
      crm_contact_id TEXT,
      crm_provider TEXT,
      twitter_handle TEXT,
      other_socials TEXT,
      city TEXT,
      state TEXT,
      timezone TEXT,
      pronouns TEXT,
      birthday TEXT,
      university TEXT,
      previous_companies TEXT,
      work_history TEXT,
      education_history TEXT,
      tags TEXT,
      relationship_strength TEXT,
      last_met_event TEXT,
      warm_intro_path TEXT,
      fund_size REAL,
      typical_check_size_min REAL,
      typical_check_size_max REAL,
      investment_stage_focus TEXT,
      investment_sector_focus TEXT,
      investment_sector_focus_notes TEXT,
      proud_portfolio_companies TEXT,
      linkedin_headline TEXT,
      linkedin_skills TEXT,
      linkedin_enriched_at TEXT,
      talent_pipeline TEXT,
      key_takeaways TEXT,
      key_takeaways_user_note TEXT,
      field_sources TEXT,
      notes TEXT,
      last_meeting_at TEXT,
      last_email_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0'
    );

    CREATE TABLE contact_emails (
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (contact_id, email),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    -- Chat tables (2026-05-24, Bug B).
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      context_kind TEXT NOT NULL,
      context_label TEXT,
      title TEXT,
      preview_text TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      cache_enabled INTEGER NOT NULL DEFAULT 1,
      attached_context_entities TEXT NOT NULL DEFAULT '[]',
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      lamport TEXT NOT NULL DEFAULT '0'
    );

    CREATE TABLE chat_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    -- Part E — user_preferences: global key/value (no user_id column on desktop).
    CREATE TABLE user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0'
    );
  `)

  db.prepare('INSERT INTO users (id) VALUES (?)').run(USER_ID)
  return db
}

function makeCompanyRow(
  overrides: Partial<PulledOrgCompanyRow> & { id: string; lamport: string },
): PulledOrgCompanyRow {
  return {
    id: overrides.id,
    userId: USER_ID,
    canonicalName: overrides.canonicalName ?? 'Acme',
    normalizedName: overrides.normalizedName ?? `acme-${overrides.id}`,
    description: null,
    primaryDomain: null,
    websiteUrl: null,
    linkedinCompanyUrl: null,
    twitterHandle: null,
    crunchbaseUrl: null,
    angellistUrl: null,
    stage: null,
    pipelineStage: null,
    priority: null,
    status: 'active',
    entityType: 'unknown',
    includeInCompaniesView: 0,
    classificationSource: 'auto',
    classificationConfidence: null,
    industry: null,
    crmProvider: null,
    crmCompanyId: null,
    city: null,
    state: null,
    hqAddress: null,
    foundingYear: null,
    employeeCountRange: null,
    targetCustomer: null,
    businessModel: null,
    productStage: null,
    revenueModel: null,
    targetInvestmentStage: null,
    targetInvestmentSector: null,
    arr: null,
    burnRate: null,
    runwayMonths: null,
    lastFundingDate: null,
    totalFundingRaised: null,
    leadInvestor: null,
    leadInvestorCompanyId: null,
    coInvestors: null,
    round: null,
    raiseSize: null,
    postMoneyValuation: null,
    relationshipOwner: null,
    dealSource: null,
    warmIntroSource: null,
    referralContactId: null,
    nextFollowupDate: null,
    investmentSize: null,
    ownershipPct: null,
    followonInvestmentSize: null,
    totalInvested: null,
    investmentRound: null,
    initialInvestmentSecurity: null,
    dateOfInitialInvestment: null,
    initialRoundSize: null,
    lastCompanyValuation: null,
    followonCheck: null,
    followonDate: null,
    followonCheck2: null,
    followonDate2: null,
    investmentMark: null,
    portfolioFund: null,
    sourceType: null,
    sourceEntityType: null,
    sourceEntityId: null,
    keyTakeaways: null,
    fieldSources: null,
    createdAt: '2026-05-22T10:00:00.000Z',
    updatedAt: '2026-05-22T10:00:00.000Z',
    lamport: overrides.lamport,
    ...overrides,
  }
}

function makeContactRow(
  overrides: Partial<PulledContactRow> & { id: string; lamport: string },
): PulledContactRow {
  return {
    id: overrides.id,
    userId: USER_ID,
    fullName: 'Alice Example',
    firstName: 'Alice',
    lastName: 'Example',
    normalizedName: `alice-${overrides.id}`,
    email: null,
    phone: null,
    primaryCompanyId: null,
    title: null,
    contactType: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    twitterHandle: null,
    otherSocials: null,
    city: null,
    state: null,
    timezone: null,
    pronouns: null,
    birthday: null,
    university: null,
    previousCompanies: null,
    workHistory: null,
    educationHistory: null,
    tags: null,
    relationshipStrength: null,
    lastMetEvent: null,
    warmIntroPath: null,
    fundSize: null,
    typicalCheckSizeMin: null,
    typicalCheckSizeMax: null,
    investmentStageFocus: null,
    investmentSectorFocus: null,
    investmentSectorFocusNotes: null,
    proudPortfolioCompanies: null,
    linkedinHeadline: null,
    linkedinSkills: null,
    linkedinEnrichedAt: null,
    talentPipeline: null,
    keyTakeaways: null,
    fieldSources: null,
    notes: null,
    lastMeetingAt: null,
    lastEmailAt: null,
    createdAt: '2026-05-22T10:00:00.000Z',
    updatedAt: '2026-05-22T10:00:00.000Z',
    lamport: overrides.lamport,
    ...overrides,
  }
}

describe('applyRemoteOrgCompanies', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  it('inserts a new company row when none exists locally', () => {
    const r = applyRemoteOrgCompanies(db, DEVICE_ID, USER_ID, [
      makeCompanyRow({ id: 'co-1', lamport: '5', canonicalName: 'Acme Inc' }),
    ])
    expect(r.appliedIds).toEqual(['co-1'])
    const row = db.prepare('SELECT canonical_name, lamport FROM org_companies WHERE id = ?').get('co-1') as
      | { canonical_name: string; lamport: string }
      | undefined
    expect(row?.canonical_name).toBe('Acme Inc')
    expect(row?.lamport).toBe('5')
  })

  it('field-LWW: a lower-lamport incoming row wins no column (local value preserved)', () => {
    // org_companies is field-LWW: the apply doesn't skip at the ROW level, it
    // merges per column. An incoming whole-row write (no field_lamports map) at a
    // lower lamport loses every column, so the local value is preserved and the
    // DB row is unchanged.
    db.prepare(
      "INSERT INTO org_companies (id, canonical_name, normalized_name, lamport) VALUES ('co-1', 'Local', 'local', '10')",
    ).run()
    applyRemoteOrgCompanies(db, DEVICE_ID, USER_ID, [
      makeCompanyRow({ id: 'co-1', lamport: '5', canonicalName: 'Remote' }),
    ])
    const row = db
      .prepare('SELECT canonical_name, lamport FROM org_companies WHERE id = ?')
      .get('co-1') as { canonical_name: string; lamport: string }
    expect(row.canonical_name).toBe('Local') // incoming lost — local preserved
  })

  it('updates existing row on higher lamport', () => {
    db.prepare(
      "INSERT INTO org_companies (id, canonical_name, normalized_name, lamport) VALUES ('co-1', 'Old Name', 'old-co-1', '1')",
    ).run()
    applyRemoteOrgCompanies(db, DEVICE_ID, USER_ID, [
      makeCompanyRow({
        id: 'co-1',
        lamport: '2',
        canonicalName: 'New Name',
        normalizedName: 'old-co-1',
      }),
    ])
    const row = db.prepare('SELECT canonical_name FROM org_companies WHERE id = ?').get('co-1') as {
      canonical_name: string
    }
    expect(row.canonical_name).toBe('New Name')
  })

  it('serialises JSON fields (coInvestors, fieldSources)', () => {
    applyRemoteOrgCompanies(db, DEVICE_ID, USER_ID, [
      makeCompanyRow({
        id: 'co-1',
        lamport: '1',
        coInvestors: ['Sequoia', 'A16Z'],
        fieldSources: { description: 'manual' },
      }),
    ])
    const row = db.prepare('SELECT co_investors, field_sources FROM org_companies WHERE id = ?').get('co-1') as {
      co_investors: string
      field_sources: string
    }
    expect(JSON.parse(row.co_investors)).toEqual(['Sequoia', 'A16Z'])
    expect(JSON.parse(row.field_sources)).toEqual({ description: 'manual' })
  })
})

describe('applyRemoteOrgCompanyAliases', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    // Seed parent company — alias has FK ON DELETE CASCADE.
    db.prepare(
      "INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES ('co-1', 'Acme', 'acme')",
    ).run()
  })
  afterEach(() => { db.close() })

  it('inserts a new alias', () => {
    const r = applyRemoteOrgCompanyAliases(db, DEVICE_ID, USER_ID, [
      {
        id: 'alias-1',
        companyId: 'co-1',
        aliasValue: 'Acme Corp',
        aliasType: 'name',
        lamport: '3',
        createdAt: '2026-05-22T10:00:00.000Z',
      },
    ])
    expect(r.appliedIds).toEqual(['alias-1'])
    const row = db.prepare('SELECT alias_value, lamport FROM org_company_aliases WHERE id = ?').get('alias-1') as
      | { alias_value: string; lamport: string }
      | undefined
    expect(row?.alias_value).toBe('Acme Corp')
    expect(row?.lamport).toBe('3')
  })

  it('does NOT require a local user row (cascade-child table)', () => {
    // Delete the user to confirm hasUserId=false skips the FK pre-check.
    db.prepare('DELETE FROM users WHERE id = ?').run(USER_ID)
    const r = applyRemoteOrgCompanyAliases(db, DEVICE_ID, USER_ID, [
      {
        id: 'alias-2',
        companyId: 'co-1',
        aliasValue: 'A.C.',
        aliasType: 'name',
        lamport: '1',
        createdAt: '2026-05-22T10:00:00.000Z',
      },
    ])
    expect(r.appliedIds).toEqual(['alias-2'])
  })
})

describe('applyRemoteContacts', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  it('inserts a new contact row', () => {
    const r = applyRemoteContacts(db, DEVICE_ID, USER_ID, [
      makeContactRow({ id: 'ct-1', lamport: '5', email: 'alice@example.com' }),
    ])
    expect(r.appliedIds).toEqual(['ct-1'])
    const row = db.prepare('SELECT full_name, email, lamport FROM contacts WHERE id = ?').get('ct-1') as
      | { full_name: string; email: string; lamport: string }
      | undefined
    expect(row?.email).toBe('alice@example.com')
    expect(row?.lamport).toBe('5')
  })

  it('preserves JSON fields (tags, work_history)', () => {
    applyRemoteContacts(db, DEVICE_ID, USER_ID, [
      makeContactRow({
        id: 'ct-1',
        lamport: '1',
        tags: ['founder', 'AI'],
        workHistory: [{ company: 'OpenAI', role: 'Engineer' }],
      }),
    ])
    const row = db.prepare('SELECT tags, work_history FROM contacts WHERE id = ?').get('ct-1') as {
      tags: string
      work_history: string
    }
    expect(JSON.parse(row.tags)).toEqual(['founder', 'AI'])
    expect(JSON.parse(row.work_history)).toEqual([{ company: 'OpenAI', role: 'Engineer' }])
  })

  it('skips when local lamport is greater', () => {
    db.prepare(
      "INSERT INTO contacts (id, full_name, normalized_name, lamport) VALUES ('ct-1', 'Local', 'local', '99')",
    ).run()
    const r = applyRemoteContacts(db, DEVICE_ID, USER_ID, [
      makeContactRow({ id: 'ct-1', lamport: '5' }),
    ])
    expect(r.appliedIds).toEqual([])
    expect(r.skippedLowLamport).toBe(1)
  })
})

describe('applyRemoteContactEmails', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    db.prepare(
      "INSERT INTO contacts (id, full_name, normalized_name) VALUES ('ct-1', 'Alice', 'alice')",
    ).run()
  })
  afterEach(() => { db.close() })

  it('inserts a contact_email row (composite PK)', () => {
    const wire: PulledContactEmailRowWire = {
      contactId: 'ct-1',
      email: 'alice@example.com',
      isPrimary: 1,
      lamport: '3',
      createdAt: '2026-05-22T10:00:00.000Z',
    }
    const r = applyRemoteContactEmails(db, DEVICE_ID, USER_ID, [wire])
    expect(r.appliedIds).toEqual(['ct-1:alice@example.com'])
    const row = db.prepare(
      'SELECT contact_id, email, is_primary, lamport FROM contact_emails WHERE contact_id = ? AND email = ?',
    ).get('ct-1', 'alice@example.com') as
      | { contact_id: string; email: string; is_primary: number; lamport: string }
      | undefined
    expect(row?.is_primary).toBe(1)
    expect(row?.lamport).toBe('3')
  })

  it('updates an existing composite row on higher lamport', () => {
    db.prepare(
      "INSERT INTO contact_emails (contact_id, email, is_primary, lamport) VALUES ('ct-1', 'alice@example.com', 0, '1')",
    ).run()
    applyRemoteContactEmails(db, DEVICE_ID, USER_ID, [
      {
        contactId: 'ct-1',
        email: 'alice@example.com',
        isPrimary: 1,
        lamport: '5',
        createdAt: '2026-05-22T10:00:00.000Z',
      },
    ])
    const row = db.prepare(
      'SELECT is_primary, lamport FROM contact_emails WHERE contact_id = ? AND email = ?',
    ).get('ct-1', 'alice@example.com') as { is_primary: number; lamport: string }
    expect(row.is_primary).toBe(1)
    expect(row.lamport).toBe('5')
  })

  it('keeps separate rows for different emails on the same contact', () => {
    applyRemoteContactEmails(db, DEVICE_ID, USER_ID, [
      { contactId: 'ct-1', email: 'a@example.com', isPrimary: 1, lamport: '1', createdAt: '2026-05-22T10:00:00.000Z' },
      { contactId: 'ct-1', email: 'b@example.com', isPrimary: 0, lamport: '2', createdAt: '2026-05-22T10:00:00.000Z' },
    ])
    const rows = db.prepare(
      'SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email',
    ).all('ct-1') as { email: string }[]
    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com'])
  })
})

// ─── Chat tables (2026-05-24, Bug B) ────────────────────────────────────────

function makeSessionRow(
  overrides: Partial<PulledChatSessionRow> & { id: string; lamport: string },
): PulledChatSessionRow {
  return {
    id: overrides.id,
    userId: USER_ID,
    contextKind: 'crm',
    contextId: `ctx-${overrides.id}`,
    contextLabel: null,
    title: 'Test session',
    previewText: null,
    messageCount: 0,
    isActive: 1,
    isPinned: 0,
    isArchived: 0,
    cacheEnabled: 1,
    lastMessageAt: '2026-05-24T10:00:00.000Z',
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    createdAt: '2026-05-24T10:00:00.000Z',
    updatedAt: '2026-05-24T10:00:00.000Z',
    lamport: overrides.lamport,
    ...overrides,
  }
}

describe('applyRemoteChatSessions', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  it('inserts a new session row', () => {
    const r = applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '5', title: 'Hi' }),
    ])
    expect(r.appliedIds).toEqual(['sess-1'])
    const row = db.prepare('SELECT title, lamport FROM chat_sessions WHERE id = ?').get('sess-1') as
      | { title: string; lamport: string }
      | undefined
    expect(row?.title).toBe('Hi')
    expect(row?.lamport).toBe('5')
  })

  it('skips when local lamport is greater-or-equal', () => {
    db.prepare(
      "INSERT INTO chat_sessions (id, context_id, context_kind, title, lamport) VALUES ('sess-1', 'ctx-1', 'crm', 'Local', '10')",
    ).run()
    const r = applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '5' }),
    ])
    expect(r.appliedIds).toEqual([])
    expect(r.skippedLowLamport).toBe(1)
  })

  it('updates session metadata on higher lamport', () => {
    db.prepare(
      "INSERT INTO chat_sessions (id, context_id, context_kind, title, lamport) VALUES ('sess-1', 'ctx-old', 'crm', 'Old', '1')",
    ).run()
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '2', title: 'Renamed', messageCount: 4 }),
    ])
    const row = db.prepare('SELECT title, message_count FROM chat_sessions WHERE id = ?').get('sess-1') as {
      title: string
      message_count: number
    }
    expect(row.title).toBe('Renamed')
    expect(row.message_count).toBe(4)
  })

  it('coerces boolean isPinned/isArchived to integer flags', () => {
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '5', isPinned: true, isArchived: false }),
    ])
    const row = db.prepare('SELECT is_pinned, is_archived FROM chat_sessions WHERE id = ?').get('sess-1') as {
      is_pinned: number
      is_archived: number
    }
    expect(row.is_pinned).toBe(1)
    expect(row.is_archived).toBe(0)
  })

  it('propagates cacheEnabled changes from the gateway', () => {
    // Initial pull with cacheEnabled=true.
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '5', cacheEnabled: true }),
    ])
    let row = db
      .prepare('SELECT cache_enabled FROM chat_sessions WHERE id = ?')
      .get('sess-1') as { cache_enabled: number }
    expect(row.cache_enabled).toBe(1)

    // Subsequent pull flips it off (e.g. user toggled on mobile).
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '6', cacheEnabled: false }),
    ])
    row = db
      .prepare('SELECT cache_enabled FROM chat_sessions WHERE id = ?')
      .get('sess-1') as { cache_enabled: number }
    expect(row.cache_enabled).toBe(0)
  })

  it('INSERT carries attached_context_entities from the wire (array → JSON text)', () => {
    const entities = [
      { type: 'company', id: 'c1', label: 'Tempo' },
      { type: 'contact', id: 'p1', label: 'Anne-Lise' },
    ]
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      // node-pg returns jsonb pre-parsed (an array), not a string.
      makeSessionRow({ id: 'sess-1', lamport: '5', attachedContextEntities: entities }),
    ])
    const row = db
      .prepare('SELECT attached_context_entities FROM chat_sessions WHERE id = ?')
      .get('sess-1') as { attached_context_entities: string }
    expect(JSON.parse(row.attached_context_entities)).toEqual(entities)
  })

  it('INSERT defaults attached_context_entities to [] when absent', () => {
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '5' }),
    ])
    const row = db
      .prepare('SELECT attached_context_entities FROM chat_sessions WHERE id = ?')
      .get('sess-1') as { attached_context_entities: string }
    expect(row.attached_context_entities).toBe('[]')
  })

  it('UPDATE preserves the LOCAL attached_context_entities (never clobbered by a pulled row)', () => {
    // Local row already has chips; lamport low so a higher-lamport pull applies.
    db.prepare(
      `INSERT INTO chat_sessions (id, context_id, context_kind, lamport, attached_context_entities)
       VALUES ('sess-1', 'ctx-1', 'crm', '1', '[{"type":"company","id":"c1","label":"Tempo"}]')`,
    ).run()
    // Pulled row is staler on chips (empty) but newer lamport — must NOT wipe chips.
    applyRemoteChatSessions(db, DEVICE_ID, USER_ID, [
      makeSessionRow({ id: 'sess-1', lamport: '9', title: 'Renamed', attachedContextEntities: [] }),
    ])
    const row = db
      .prepare('SELECT title, attached_context_entities FROM chat_sessions WHERE id = ?')
      .get('sess-1') as { title: string; attached_context_entities: string }
    expect(row.title).toBe('Renamed') // metadata still updates
    expect(JSON.parse(row.attached_context_entities)).toEqual([
      { type: 'company', id: 'c1', label: 'Tempo' },
    ]) // chips preserved
  })
})

describe('applyRemoteChatSessionMessages', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    // Seed parent session so FK is satisfied for inserts below.
    db.prepare(
      "INSERT INTO chat_sessions (id, context_id, context_kind, lamport) VALUES ('sess-1', 'ctx-1', 'crm', '1')",
    ).run()
  })
  afterEach(() => { db.close() })

  it('inserts a new message row', () => {
    const r = applyRemoteChatSessionMessages(db, DEVICE_ID, USER_ID, [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hello',
        attachmentsJson: null,
        createdAt: '2026-05-24T10:00:00.000Z',
        lamport: '3',
      },
    ])
    expect(r.appliedIds).toEqual(['msg-1'])
    const row = db.prepare('SELECT role, content, lamport FROM chat_session_messages WHERE id = ?').get('msg-1') as {
      role: string
      content: string
      lamport: string
    }
    expect(row.role).toBe('user')
    expect(row.content).toBe('Hello')
    expect(row.lamport).toBe('3')
  })

  it('skips when local lamport is greater-or-equal', () => {
    db.prepare(
      "INSERT INTO chat_session_messages (id, session_id, role, content, lamport) VALUES ('msg-1', 'sess-1', 'user', 'old', '99')",
    ).run()
    const r = applyRemoteChatSessionMessages(db, DEVICE_ID, USER_ID, [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'new',
        attachmentsJson: null,
        createdAt: '2026-05-24T10:00:00.000Z',
        lamport: '5',
      },
    ])
    expect(r.appliedIds).toEqual([])
    expect(r.skippedLowLamport).toBe(1)
  })

  it('serialises attachmentsJson when provided', () => {
    applyRemoteChatSessionMessages(db, DEVICE_ID, USER_ID, [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Reply',
        attachmentsJson: [{ kind: 'meeting', id: 'mtg-1' }],
        createdAt: '2026-05-24T10:00:00.000Z',
        lamport: '3',
      },
    ])
    const row = db.prepare(
      'SELECT attachments_json FROM chat_session_messages WHERE id = ?',
    ).get('msg-1') as { attachments_json: string }
    expect(JSON.parse(row.attachments_json)).toEqual([{ kind: 'meeting', id: 'mtg-1' }])
  })
})

describe('applyRemoteUserPreferences (Part E)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })
  afterEach(() => db.close())

  function pref(over: Partial<PulledUserPreferenceRowWire> & { key: string; lamport: string }): PulledUserPreferenceRowWire {
    return {
      key: over.key,
      value: over.value ?? '20',
      lamport: over.lamport,
      updatedAt: over.updatedAt ?? '2026-06-01T10:00:00.000Z',
    }
  }

  it('inserts a new preference row when none exists locally', () => {
    const res = applyRemoteUserPreferences(db, DEVICE_ID, USER_ID, [
      pref({ key: 'emailThreadsPerCompany', value: '35', lamport: '5' }),
    ])
    expect(res.appliedIds).toEqual(['emailThreadsPerCompany'])
    const row = db.prepare('SELECT value, lamport FROM user_preferences WHERE key = ?')
      .get('emailThreadsPerCompany') as { value: string; lamport: string }
    expect(row.value).toBe('35')
    expect(row.lamport).toBe('5')
  })

  it('skips when local lamport is greater-or-equal (LWW)', () => {
    db.prepare("INSERT INTO user_preferences (key, value, lamport) VALUES ('emailThreadsPerCompany', '10', '9')").run()
    applyRemoteUserPreferences(db, DEVICE_ID, USER_ID, [
      pref({ key: 'emailThreadsPerCompany', value: '99', lamport: '4' }),
    ])
    const row = db.prepare('SELECT value FROM user_preferences WHERE key = ?')
      .get('emailThreadsPerCompany') as { value: string }
    expect(row.value).toBe('10') // unchanged — incoming lamport lower
  })

  it('updates on higher lamport', () => {
    db.prepare("INSERT INTO user_preferences (key, value, lamport) VALUES ('emailThreadsPerCompany', '10', '2')").run()
    applyRemoteUserPreferences(db, DEVICE_ID, USER_ID, [
      pref({ key: 'emailThreadsPerCompany', value: '50', lamport: '7' }),
    ])
    const row = db.prepare('SELECT value FROM user_preferences WHERE key = ?')
      .get('emailThreadsPerCompany') as { value: string }
    expect(row.value).toBe('50')
  })
})
