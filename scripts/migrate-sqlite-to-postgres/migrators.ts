// Per-table migrators. Order matters — FK dependencies must migrate before
// their dependents (e.g. users → org_companies → contacts → meetings → notes).
//
// Each migrator returns an array of parameters matching its insertSql's $1..$N.
// Empty / unparseable timestamps and JSON return null per transform helpers.

import type { Migrator } from './index.ts'
import {
  jsonbParam,
  jsonbParamRequired,
  nullableInt,
  nullableNumber,
  nullableText,
  parseSqliteBoolean,
  parseSqliteTimestamp,
  preserveText,
} from '../../packages/db/src/sync/transforms.ts'

export function allMigrators(userId: string): Migrator[] {
  return [
    // === Layer 1: no inbound FKs from other migrated tables ====================
    templates(userId),
    themes(userId),
    pipelineConfigs(userId),
    speakers(userId),

    // === Layer 2: depend on layer 1 =============================================
    pipelineStages(userId),
    orgCompanies(userId),

    // === Layer 3: depend on layer 2 =============================================
    orgCompanyAliases(userId),
    contacts(userId),

    // === Layer 4: depend on layer 3 =============================================
    contactEmails(userId),
    meetings(userId),

    // === Layer 5: depend on meetings + contacts + companies =====================
    meetingSpeakers(userId),
    meetingCompanyLinks(userId),
    meetingSpeakerContactLinks(userId),
    notes(userId),
    noteFolders(userId),
    tasks(userId),
    chatSessions(userId),
    chatSessionMessages(userId),
  ]
}

// =============================================================================
// LAYER 1
// =============================================================================

function templates(userId: string): Migrator {
  return {
    sourceTable: 'templates',
    targetTable: 'templates',
    countSql: `SELECT count(*) as c FROM templates`,
    selectSql: `SELECT * FROM templates`,
    insertSql: `
      INSERT INTO templates (
        id, user_id, name, description, category, system_prompt, user_prompt_template,
        instructions, output_format, is_default, is_active, sort_order,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.name,
      nullableText(r.description),
      r.category,
      r.system_prompt,
      r.user_prompt_template,
      nullableText(r.instructions),
      r.output_format ?? 'markdown',
      parseSqliteBoolean(r.is_default) ?? false,
      parseSqliteBoolean(r.is_active) ?? true,
      nullableInt(r.sort_order) ?? 0,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

function themes(userId: string): Migrator {
  return {
    sourceTable: 'themes',
    targetTable: 'themes',
    countSql: `SELECT count(*) as c FROM themes`,
    selectSql: `SELECT * FROM themes`,
    insertSql: `
      INSERT INTO themes (
        id, user_id, name, slug, thesis_statement, status, conviction_score,
        owner_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.name,
      r.slug,
      nullableText(r.thesis_statement),
      r.status ?? 'exploring',
      nullableInt(r.conviction_score),
      nullableText(r.owner_name),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

function pipelineConfigs(userId: string): Migrator {
  return {
    sourceTable: 'pipeline_configs',
    targetTable: 'pipeline_configs',
    countSql: `SELECT count(*) as c FROM pipeline_configs`,
    selectSql: `SELECT * FROM pipeline_configs`,
    insertSql: `
      INSERT INTO pipeline_configs (id, user_id, name, is_default, created_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.name,
      parseSqliteBoolean(r.is_default) ? 1 : 0,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function speakers(userId: string): Migrator {
  return {
    sourceTable: 'speakers',
    targetTable: 'speakers',
    countSql: `SELECT count(*) as c FROM speakers`,
    selectSql: `SELECT * FROM speakers`,
    insertSql: `
      INSERT INTO speakers (id, user_id, name, notes, created_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.name,
      nullableText(r.notes),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

// =============================================================================
// LAYER 2
// =============================================================================

function pipelineStages(userId: string): Migrator {
  return {
    sourceTable: 'pipeline_stages',
    targetTable: 'pipeline_stages',
    countSql: `SELECT count(*) as c FROM pipeline_stages`,
    selectSql: `SELECT * FROM pipeline_stages`,
    insertSql: `
      INSERT INTO pipeline_stages (
        id, pipeline_config_id, label, slug, sort_order, color, is_terminal, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      r.pipeline_config_id,
      r.label,
      r.slug,
      nullableInt(r.sort_order) ?? 0,
      nullableText(r.color),
      parseSqliteBoolean(r.is_terminal) ? 1 : 0,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function orgCompanies(userId: string): Migrator {
  return {
    sourceTable: 'org_companies',
    targetTable: 'org_companies',
    countSql: `SELECT count(*) as c FROM org_companies`,
    selectSql: `SELECT * FROM org_companies`,
    insertSql: `
      INSERT INTO org_companies (
        id, user_id, canonical_name, normalized_name, description,
        primary_domain, website_url, linkedin_company_url, twitter_handle,
        crunchbase_url, angellist_url, stage, pipeline_stage, priority, status,
        entity_type, include_in_companies_view, classification_source,
        classification_confidence, industry, crm_provider, crm_company_id,
        city, state, hq_address, founding_year, employee_count_range,
        target_customer, business_model, product_stage, revenue_model,
        arr, burn_rate, runway_months, last_funding_date, total_funding_raised,
        lead_investor, lead_investor_company_id, co_investors,
        round, raise_size, post_money_valuation,
        relationship_owner, deal_source, warm_intro_source, referral_contact_id,
        next_followup_date, investment_size, ownership_pct, followon_investment_size,
        total_invested, investment_round, initial_investment_security,
        date_of_initial_investment, initial_round_size, last_company_valuation,
        followon_check, followon_date, followon_check_2, followon_date_2,
        investment_mark, portfolio_fund, source_type, source_entity_type,
        source_entity_id, key_takeaways, field_sources, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,
        $46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
        $61,$62,$63,$64,$65,$66,$67,$68,$69)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.canonical_name,
      r.normalized_name,
      nullableText(r.description),
      nullableText(r.primary_domain),
      nullableText(r.website_url),
      nullableText(r.linkedin_company_url),
      nullableText(r.twitter_handle),
      nullableText(r.crunchbase_url),
      nullableText(r.angellist_url),
      nullableText(r.stage),
      nullableText(r.pipeline_stage),
      nullableText(r.priority),
      r.status ?? 'active',
      r.entity_type ?? 'unknown',
      parseSqliteBoolean(r.include_in_companies_view) ? 1 : 0,
      r.classification_source ?? 'auto',
      nullableNumber(r.classification_confidence),
      nullableText(r.industry),
      nullableText(r.crm_provider),
      nullableText(r.crm_company_id),
      nullableText(r.city),
      nullableText(r.state),
      nullableText(r.hq_address),
      nullableInt(r.founding_year),
      nullableText(r.employee_count_range),
      nullableText(r.target_customer),
      nullableText(r.business_model),
      nullableText(r.product_stage),
      nullableText(r.revenue_model),
      nullableNumber(r.arr),
      nullableNumber(r.burn_rate),
      nullableInt(r.runway_months),
      parseSqliteTimestamp(r.last_funding_date),
      nullableNumber(r.total_funding_raised),
      nullableText(r.lead_investor),
      nullableText(r.lead_investor_company_id),
      jsonbParam(r.co_investors, 'org_companies.co_investors'),
      nullableText(r.round),
      nullableNumber(r.raise_size),
      nullableNumber(r.post_money_valuation),
      nullableText(r.relationship_owner),
      nullableText(r.deal_source),
      nullableText(r.warm_intro_source),
      nullableText(r.referral_contact_id),
      parseSqliteTimestamp(r.next_followup_date),
      nullableText(r.investment_size),
      nullableText(r.ownership_pct),
      nullableText(r.followon_investment_size),
      nullableText(r.total_invested),
      nullableText(r.investment_round),
      nullableText(r.initial_investment_security),
      parseSqliteTimestamp(r.date_of_initial_investment),
      nullableNumber(r.initial_round_size),
      nullableNumber(r.last_company_valuation),
      nullableNumber(r.followon_check),
      parseSqliteTimestamp(r.followon_date),
      nullableNumber(r.followon_check_2),
      parseSqliteTimestamp(r.followon_date_2),
      nullableNumber(r.investment_mark),
      nullableText(r.portfolio_fund),
      nullableText(r.source_type),
      nullableText(r.source_entity_type),
      nullableText(r.source_entity_id),
      nullableText(r.key_takeaways),
      jsonbParam(r.field_sources, 'org_companies.field_sources'),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

// =============================================================================
// LAYER 3
// =============================================================================

function orgCompanyAliases(userId: string): Migrator {
  return {
    sourceTable: 'org_company_aliases',
    targetTable: 'org_company_aliases',
    countSql: `SELECT count(*) as c FROM org_company_aliases`,
    selectSql: `SELECT * FROM org_company_aliases`,
    insertSql: `
      INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type, created_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      r.company_id,
      r.alias_value,
      r.alias_type,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function contacts(userId: string): Migrator {
  return {
    sourceTable: 'contacts',
    targetTable: 'contacts',
    countSql: `SELECT count(*) as c FROM contacts`,
    selectSql: `SELECT * FROM contacts`,
    insertSql: `
      INSERT INTO contacts (
        id, user_id, full_name, first_name, last_name, normalized_name,
        email, phone, primary_company_id, title, contact_type,
        linkedin_url, crm_contact_id, crm_provider, twitter_handle, other_socials,
        city, state, street, postal_code, country, timezone, pronouns, birthday,
        university, previous_companies, work_history, education_history,
        tags, relationship_strength, last_met_event, warm_intro_path,
        investor_stage, fund_size, typical_check_size_min, typical_check_size_max,
        investment_stage_focus, investment_sector_focus, investment_sector_focus_notes,
        proud_portfolio_companies, linkedin_headline, linkedin_skills, linkedin_enriched_at,
        talent_pipeline, key_takeaways, field_sources, notes,
        last_meeting_at, last_email_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,
        $46,$47,$48,$49,$50,$51)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.full_name,
      nullableText(r.first_name),
      nullableText(r.last_name),
      r.normalized_name,
      nullableText(r.email),
      nullableText(r.phone),
      nullableText(r.primary_company_id),
      nullableText(r.title),
      nullableText(r.contact_type),
      nullableText(r.linkedin_url),
      nullableText(r.crm_contact_id),
      nullableText(r.crm_provider),
      nullableText(r.twitter_handle),
      jsonbParam(r.other_socials, 'contacts.other_socials'),
      nullableText(r.city),
      nullableText(r.state),
      nullableText(r.street),
      nullableText(r.postal_code),
      nullableText(r.country),
      nullableText(r.timezone),
      nullableText(r.pronouns),
      nullableText(r.birthday),
      nullableText(r.university),
      jsonbParam(r.previous_companies, 'contacts.previous_companies'),
      jsonbParam(r.work_history, 'contacts.work_history'),
      jsonbParam(r.education_history, 'contacts.education_history'),
      jsonbParam(r.tags, 'contacts.tags'),
      nullableText(r.relationship_strength),
      nullableText(r.last_met_event),
      nullableText(r.warm_intro_path),
      nullableText(r.investor_stage),
      nullableNumber(r.fund_size),
      nullableNumber(r.typical_check_size_min),
      nullableNumber(r.typical_check_size_max),
      jsonbParam(r.investment_stage_focus, 'contacts.investment_stage_focus'),
      jsonbParam(r.investment_sector_focus, 'contacts.investment_sector_focus'),
      nullableText(r.investment_sector_focus_notes),
      jsonbParam(r.proud_portfolio_companies, 'contacts.proud_portfolio_companies'),
      nullableText(r.linkedin_headline),
      jsonbParam(r.linkedin_skills, 'contacts.linkedin_skills'),
      parseSqliteTimestamp(r.linkedin_enriched_at),
      nullableText(r.talent_pipeline),
      nullableText(r.key_takeaways),
      jsonbParam(r.field_sources, 'contacts.field_sources'),
      nullableText(r.notes),
      null, // last_meeting_at — denormalized; populated by a post-migration backfill pass
      null, // last_email_at — same
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

// =============================================================================
// LAYER 4
// =============================================================================

function contactEmails(userId: string): Migrator {
  return {
    sourceTable: 'contact_emails',
    targetTable: 'contact_emails',
    countSql: `SELECT count(*) as c FROM contact_emails`,
    selectSql: `SELECT * FROM contact_emails`,
    insertSql: `
      INSERT INTO contact_emails (contact_id, email, is_primary, created_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (contact_id, email) DO NOTHING`,
    transform: (r) => [
      r.contact_id,
      r.email,
      parseSqliteBoolean(r.is_primary) ? 1 : 0,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function meetings(userId: string): Migrator {
  return {
    sourceTable: 'meetings',
    targetTable: 'meetings',
    countSql: `SELECT count(*) as c FROM meetings`,
    selectSql: `SELECT * FROM meetings`,
    insertSql: `
      INSERT INTO meetings (
        id, user_id, title, date, duration_seconds, calendar_event_id,
        meeting_platform, meeting_url, transcript_path, summary_path, recording_path,
        transcript_drive_id, summary_drive_id, template_id,
        speaker_count, speaker_map, transcript_segments, notes,
        attendees, attendee_emails, chat_messages, companies, dismissed_companies,
        status, was_impromptu, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.title,
      parseSqliteTimestamp(r.date) ?? new Date(),
      nullableInt(r.duration_seconds),
      nullableText(r.calendar_event_id),
      nullableText(r.meeting_platform),
      nullableText(r.meeting_url),
      nullableText(r.transcript_path),
      nullableText(r.summary_path),
      nullableText(r.recording_path),
      nullableText(r.transcript_drive_id),
      nullableText(r.summary_drive_id),
      nullableText(r.template_id),
      nullableInt(r.speaker_count) ?? 0,
      jsonbParamRequired(r.speaker_map, {}, 'meetings.speaker_map'),
      jsonbParam(r.transcript_segments, 'meetings.transcript_segments'),
      nullableText(r.notes),
      jsonbParam(r.attendees, 'meetings.attendees'),
      jsonbParam(r.attendee_emails, 'meetings.attendee_emails'),
      jsonbParam(r.chat_messages, 'meetings.chat_messages'),
      jsonbParam(r.companies, 'meetings.companies'),
      jsonbParam(r.dismissed_companies, 'meetings.dismissed_companies'),
      r.status ?? 'recording',
      false, // was_impromptu — new mobile-only field; pre-existing rows default false
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

// =============================================================================
// LAYER 5
// =============================================================================

function meetingSpeakers(userId: string): Migrator {
  return {
    sourceTable: 'meeting_speakers',
    targetTable: 'meeting_speakers',
    countSql: `SELECT count(*) as c FROM meeting_speakers`,
    selectSql: `SELECT * FROM meeting_speakers`,
    insertSql: `
      INSERT INTO meeting_speakers (meeting_id, speaker_index, speaker_id, label)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (meeting_id, speaker_index) DO NOTHING`,
    transform: (r) => [
      r.meeting_id,
      nullableInt(r.speaker_index),
      nullableText(r.speaker_id),
      r.label ?? 'Speaker',
    ],
  }
}

function meetingCompanyLinks(userId: string): Migrator {
  return {
    sourceTable: 'meeting_company_links',
    targetTable: 'meeting_company_links',
    countSql: `SELECT count(*) as c FROM meeting_company_links`,
    selectSql: `SELECT * FROM meeting_company_links`,
    insertSql: `
      INSERT INTO meeting_company_links (meeting_id, company_id, confidence, linked_by, created_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (meeting_id, company_id) DO NOTHING`,
    transform: (r) => [
      r.meeting_id,
      r.company_id,
      nullableNumber(r.confidence) ?? 1.0,
      r.linked_by ?? 'auto',
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function meetingSpeakerContactLinks(userId: string): Migrator {
  return {
    sourceTable: 'meeting_speaker_contact_links',
    targetTable: 'meeting_speaker_contact_links',
    countSql: `SELECT count(*) as c FROM meeting_speaker_contact_links`,
    selectSql: `SELECT * FROM meeting_speaker_contact_links`,
    insertSql: `
      INSERT INTO meeting_speaker_contact_links (meeting_id, speaker_index, contact_id, created_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (meeting_id, speaker_index) DO NOTHING`,
    transform: (r) => [
      r.meeting_id,
      nullableInt(r.speaker_index),
      r.contact_id,
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}

function notes(userId: string): Migrator {
  return {
    sourceTable: 'notes',
    targetTable: 'notes',
    countSql: `SELECT count(*) as c FROM notes`,
    selectSql: `SELECT * FROM notes`,
    insertSql: `
      INSERT INTO notes (
        id, user_id, title, content, company_id, contact_id, source_meeting_id,
        theme_id, is_pinned, folder_path, import_source, source_digest_id,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      nullableText(r.title),
      preserveText(r.content),
      nullableText(r.company_id),
      nullableText(r.contact_id),
      nullableText(r.source_meeting_id),
      nullableText(r.theme_id),
      parseSqliteBoolean(r.is_pinned) ? 1 : 0,
      nullableText(r.folder_path),
      nullableText(r.import_source),
      nullableText(r.source_digest_id),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

function noteFolders(userId: string): Migrator {
  return {
    sourceTable: 'note_folders',
    targetTable: 'note_folders',
    countSql: `SELECT count(*) as c FROM note_folders`,
    selectSql: `SELECT * FROM note_folders`,
    insertSql: `
      INSERT INTO note_folders (path, user_id, created_at)
      VALUES ($1,$2,$3)
      ON CONFLICT (path) DO NOTHING`,
    transform: (r) => [r.path, userId, parseSqliteTimestamp(r.created_at) ?? new Date()],
  }
}

function tasks(userId: string): Migrator {
  return {
    sourceTable: 'tasks',
    targetTable: 'tasks',
    countSql: `SELECT count(*) as c FROM tasks`,
    selectSql: `SELECT * FROM tasks`,
    insertSql: `
      INSERT INTO tasks (
        id, user_id, title, description, meeting_id, company_id, contact_id,
        status, category, priority, assignee, due_date, source, source_section,
        extraction_hash, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.title,
      nullableText(r.description),
      nullableText(r.meeting_id),
      nullableText(r.company_id),
      nullableText(r.contact_id),
      r.status ?? 'open',
      r.category ?? 'action_item',
      nullableText(r.priority),
      nullableText(r.assignee),
      parseSqliteTimestamp(r.due_date),
      r.source ?? 'manual',
      nullableText(r.source_section),
      nullableText(r.extraction_hash),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

function chatSessions(userId: string): Migrator {
  return {
    sourceTable: 'chat_sessions',
    targetTable: 'chat_sessions',
    countSql: `SELECT count(*) as c FROM chat_sessions`,
    selectSql: `SELECT * FROM chat_sessions`,
    insertSql: `
      INSERT INTO chat_sessions (
        id, user_id, context_id, context_kind, context_label, title, preview_text,
        message_count, is_active, is_pinned, is_archived,
        last_message_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      userId,
      r.context_id,
      r.context_kind,
      nullableText(r.context_label),
      nullableText(r.title),
      nullableText(r.preview_text),
      nullableInt(r.message_count) ?? 0,
      parseSqliteBoolean(r.is_active) ? 1 : 0,
      parseSqliteBoolean(r.is_pinned) ? 1 : 0,
      parseSqliteBoolean(r.is_archived) ? 1 : 0,
      parseSqliteTimestamp(r.last_message_at) ?? new Date(),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
      parseSqliteTimestamp(r.updated_at) ?? new Date(),
    ],
  }
}

function chatSessionMessages(userId: string): Migrator {
  return {
    sourceTable: 'chat_session_messages',
    targetTable: 'chat_session_messages',
    countSql: `SELECT count(*) as c FROM chat_session_messages`,
    selectSql: `SELECT * FROM chat_session_messages`,
    insertSql: `
      INSERT INTO chat_session_messages (id, session_id, role, content, attachments_json, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO NOTHING`,
    transform: (r) => [
      r.id,
      r.session_id,
      r.role,
      r.content,
      jsonbParam(r.attachments_json, 'chat_session_messages.attachments_json'),
      parseSqliteTimestamp(r.created_at) ?? new Date(),
    ],
  }
}
