// @cyggie/db/schema — drizzle schema barrel.
//
// Layout:
//   auth.ts          — users, sessions, oauth_tokens (gateway-new)
//   sync.ts          — outbox, sync_state, migration_progress (gateway-new)
//   audit.ts         — audit_log (gateway-new, extends desktop's audit.repo.ts pattern)
//   meetings.ts      — meetings + speaker tables (Phase 0.2 — TODO, port from migrations 001,004,006,011,055,...)
//   templates.ts     — templates (Phase 0.2 — TODO, port from migration 001 + extensions)
//   companies.ts     — org_companies + variants (Phase 0.2 — TODO, port from migrations 008,012-014,016-021,028,050,066,072-076)
//   contacts.ts      — contacts (Phase 0.2 — TODO, port from migrations 022,023,027,036,038,041,048,051,068,069,...)
//   notes.ts         — unified notes table (Phase 0.2 — TODO, port from migration 052+057,058,065)
//   tasks.ts         — tasks (Phase 0.2 — TODO, port from migration 031)
//   chat.ts          — chat_sessions, chat_session_messages (Phase 0.2 — TODO, port from migration 078)
//   custom_fields.ts — field defs + values (Phase 0.2 — TODO, port from migrations 039,040,046,049)
//   settings.ts      — settings, user_preferences (Phase 0.2 — TODO, port from migration 001,043)
//   pipeline.ts      — pipeline_stages + deal flow (Phase 0.2 — TODO, port from migrations 026,029)
//   audit.ts         — audit log (gateway-new) [already done]
//   memos.ts         — investment memos + evidence (Phase 0.2 — TODO, port from migrations 017,...,090)
//   partner_meeting.ts — partner meeting digest tables (Phase 0.2 — TODO, port from migrations 059,061)
//   pitch_decks.ts   — pitch deck ingestion + analysis (Phase 0.2 — TODO)
//   stress_test.ts   — stress test reports (Phase 0.2 — TODO)
//
// See MIGRATION_AUDIT.md in this package for the per-migration porting status.
export * from './auth'
export * from './firms'
export * from './sync'
export * from './audit'
export * from './templates'
// Note: contacts and companies are mutually circular at the type level (contacts has
// primaryCompanyId → orgCompanies; orgCompanies has referralContactId → contacts).
// Drizzle's `.references(() => ...)` lazy callback makes this safe at module load.
export * from './companies'
export * from './contacts'
export * from './meetings'
export * from './themes'
export * from './notes'
export * from './tasks'
export * from './chat'
export * from './pipeline'
export * from './custom_fields'
export * from './settings'
export * from './partner_meeting'
export * from './deals'
export * from './memos'
export * from './agents'
export * from './stress_test'
