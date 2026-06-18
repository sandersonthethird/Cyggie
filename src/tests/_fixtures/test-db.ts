/**
 * Shared in-memory test database fixture.
 *
 * Runs the same migration sequence as the production app (see
 * `src/main/database/connection.ts:getDatabase`). Tests can call
 * `buildTestDbFull()` to get a database with the canonical schema —
 * no more inline CREATE TABLE drift when production migrations land.
 *
 * Existing pattern reused: `src/tests/chat-session.repo.test.ts`
 * already imports and calls one migration; this module generalizes
 * to all of them.
 *
 *      ┌─────────────────────────────────────────────────────────┐
 *      │  buildTestDbFull()                                      │
 *      │     ↓                                                    │
 *      │  new Database(':memory:')                                │
 *      │     ↓                                                    │
 *      │  runMigrations(db)            (001)                     │
 *      │  runFtsMigration(db)          (002)                     │
 *      │  ...                          (003..095, in order)      │
 *      │     ↓                                                    │
 *      │  return db                                               │
 *      └─────────────────────────────────────────────────────────┘
 *
 * If a new migration is added in production, append it to ALL_MIGRATIONS
 * below in the same order it appears in connection.ts.
 */
import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { runMigrations } from '@cyggie/db/sqlite/migrations/001-initial-schema'
import { runFtsMigration } from '@cyggie/db/sqlite/migrations/002-fts5-tables'
import { runNotesMigration } from '@cyggie/db/sqlite/migrations/003-notes-column'
import { runTranscriptSegmentsMigration } from '@cyggie/db/sqlite/migrations/004-transcript-segments'
import { runDriveColumnsMigration } from '@cyggie/db/sqlite/migrations/005-drive-columns'
import { runAttendeesMigration } from '@cyggie/db/sqlite/migrations/006-attendees-column'
import { runChatMessagesMigration } from '@cyggie/db/sqlite/migrations/007-chat-messages'
import { runCompaniesMigration } from '@cyggie/db/sqlite/migrations/008-companies'
import { runCompaniesCacheMigration } from '@cyggie/db/sqlite/migrations/009-companies-cache'
import { runClearCompanyCacheMigration } from '@cyggie/db/sqlite/migrations/010-clear-company-cache'
import { runRecordingPathMigration } from '@cyggie/db/sqlite/migrations/011-recording-path'
import { runCompanyOsCoreMigration } from '@cyggie/db/sqlite/migrations/012-company-os-core'
import { runCompanyOsEmailMigration } from '@cyggie/db/sqlite/migrations/013-company-os-email'
import { runCompanyOsArtifactsMigration } from '@cyggie/db/sqlite/migrations/014-company-os-artifacts'
import { runCompanyOsNotesMigration } from '@cyggie/db/sqlite/migrations/016-company-os-notes'
import { runCompanyOsMemoMigration } from '@cyggie/db/sqlite/migrations/017-company-os-memo'
import { runCompanyOsThesisMigration } from '@cyggie/db/sqlite/migrations/018-company-os-thesis'
import { runCompanyOsBackfillMigration } from '@cyggie/db/sqlite/migrations/019-company-os-backfill'
import { runCompanyClassificationMigration } from '@cyggie/db/sqlite/migrations/020-company-classification'
import { runCompanyDomainNormalizationMigration } from '@cyggie/db/sqlite/migrations/021-company-domain-normalization'
import { runContactMultiEmailMigration } from '@cyggie/db/sqlite/migrations/022-contact-multi-email'
import { runContactNamePartsMigration } from '@cyggie/db/sqlite/migrations/023-contact-name-parts'
import { runDataIntegrityMigration } from '@cyggie/db/sqlite/migrations/024-data-integrity'
import { runAuthFoundationMigration } from '@cyggie/db/sqlite/migrations/025-auth-foundation'
import { runPipelineStagesMigration } from '@cyggie/db/sqlite/migrations/026-pipeline-stages'
import { runContactTypeMigration } from '@cyggie/db/sqlite/migrations/027-contact-type'
import { runCompanyLocationMigration } from '@cyggie/db/sqlite/migrations/028-company-location'
import { runPipelineCompanyFieldsMigration } from '@cyggie/db/sqlite/migrations/029-pipeline-company-fields'
import { runPerformanceIndexesMigration } from '@cyggie/db/sqlite/migrations/030-performance-indexes'
import { runTasksMigration } from '@cyggie/db/sqlite/migrations/031-tasks'
import { runUserProfileFieldsMigration } from '@cyggie/db/sqlite/migrations/032-user-profile-fields'
import { runUserNamePartsMigration } from '@cyggie/db/sqlite/migrations/033-user-name-parts'
import { runTemplateInstructionsMigration } from '@cyggie/db/sqlite/migrations/034-template-instructions'
import { runCompanyFlaggedFilesMigration } from '@cyggie/db/sqlite/migrations/035-company-flagged-files'
import { runContactExtraFieldsMigration } from '@cyggie/db/sqlite/migrations/036-contact-extra-fields'
import { runCompanyExtraFieldsMigration } from '@cyggie/db/sqlite/migrations/037-company-extra-fields'
import { runContactExtraFieldsV2Migration } from '@cyggie/db/sqlite/migrations/038-contact-extra-fields-v2'
import { runCustomFieldDefinitionsMigration } from '@cyggie/db/sqlite/migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from '@cyggie/db/sqlite/migrations/040-custom-field-values'
import { runContactNotesMigration } from '@cyggie/db/sqlite/migrations/041-contact-notes'
import { runMeetingNotesSourceMigration } from '@cyggie/db/sqlite/migrations/042-meeting-notes-source'
import { runUserPreferencesMigration } from '@cyggie/db/sqlite/migrations/043-user-preferences'
import { runCompanyDecisionLogsMigration } from '@cyggie/db/sqlite/migrations/044-company-decision-logs'
import { runPortfolioCompanyFieldsMigration } from '@cyggie/db/sqlite/migrations/045-portfolio-company-fields'
import { runBuiltinFieldDefsMigration } from '@cyggie/db/sqlite/migrations/046-builtin-field-defs'
import { runBackfillNormalizedNamesMigration } from '@cyggie/db/sqlite/migrations/047-backfill-normalized-names'
import { runContactFieldSourcesMigration } from '@cyggie/db/sqlite/migrations/048-contact-field-sources'
import { runCustomFieldSectionMigration } from '@cyggie/db/sqlite/migrations/049-custom-field-section'
import { runCompanyFieldSourcesMigration } from '@cyggie/db/sqlite/migrations/050-company-field-sources'
import { runContactDecisionLogsMigration } from '@cyggie/db/sqlite/migrations/051-contact-decision-logs'
import { runUnifiedNotesMigration } from '@cyggie/db/sqlite/migrations/052-unified-notes'
import { runConvertManualNotesMigration } from '@cyggie/db/sqlite/migrations/053-convert-manual-notes'
import { runNotesFts5Migration } from '@cyggie/db/sqlite/migrations/054-notes-fts5'
import { runSpeakerContactLinksMigration } from '@cyggie/db/sqlite/migrations/055-speaker-contact-links'
import { runCompanyNewFieldsMigration } from '@cyggie/db/sqlite/migrations/056-company-new-fields'
import { runNotesFolderPathMigration } from '@cyggie/db/sqlite/migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from '@cyggie/db/sqlite/migrations/058-note-folders'
import { runPartnerMeetingMigration } from '@cyggie/db/sqlite/migrations/059-partner-meeting'
import { runRepairOwnCompanyContactsMigration } from '@cyggie/db/sqlite/migrations/060-repair-own-company-contacts'
import { runPartnerMeetingLinkedMeetingMigration } from '@cyggie/db/sqlite/migrations/061-partner-meeting-linked-meeting'
import { runRepairOwnerLinkedinUrlMigration } from '@cyggie/db/sqlite/migrations/062-repair-owner-linkedin-url'
import { runRemoveNotificationContactsMigration } from '@cyggie/db/sqlite/migrations/063-remove-notification-contacts'
import { runCalendarEventDedupMigration } from '@cyggie/db/sqlite/migrations/064-calendar-event-dedup'
import { runRepairImportedNoteFrontmatterMigration } from '@cyggie/db/sqlite/migrations/065-repair-imported-note-frontmatter'
import { runContactLinkedinFieldsMigration } from '@cyggie/db/sqlite/migrations/066-contact-linkedin-fields'
import { runRepairCompanyViewFlagMigration } from '@cyggie/db/sqlite/migrations/067-repair-company-view-flag'
import { runContactTalentPipelineMigration } from '@cyggie/db/sqlite/migrations/068-contact-talent-pipeline'
import { runContactKeyTakeawaysMigration } from '@cyggie/db/sqlite/migrations/069-contact-key-takeaways'
import { runCompanyKeyTakeawaysMigration } from '@cyggie/db/sqlite/migrations/070-company-key-takeaways'
import { runMeetingDismissedCompaniesMigration } from '@cyggie/db/sqlite/migrations/071-meeting-dismissed-companies'
import { runCompanyPortfolioFundMigration } from '@cyggie/db/sqlite/migrations/072-company-portfolio-fund'
import { runPortfolioInvestmentFieldsMigration } from '@cyggie/db/sqlite/migrations/073-portfolio-investment-fields'
import { runBackfillCompanyDomainsMigration } from '@cyggie/db/sqlite/migrations/074-backfill-company-domains'
import { runCompanyInvestorsPositionMigration } from '@cyggie/db/sqlite/migrations/075-company-investors-position'
import { runLeadInvestorCompanyIdMigration } from '@cyggie/db/sqlite/migrations/076-lead-investor-company-id'
import { runIndustryConsolidationMigration } from '@cyggie/db/sqlite/migrations/077-industry-consolidation'
import { runChatSessionsMigration } from '@cyggie/db/sqlite/migrations/078-chat-sessions'
import { runDropCompanyConversationsMigration } from '@cyggie/db/sqlite/migrations/079-drop-company-conversations'
import { runBackfillMeetingChatsMigration } from '@cyggie/db/sqlite/migrations/080-backfill-meeting-chats'
import { runDropLegacyNotesTablesMigration } from '@cyggie/db/sqlite/migrations/081-drop-legacy-notes-tables'
import { runNotesSourceMeetingUniqueMigration } from '@cyggie/db/sqlite/migrations/082-notes-source-meeting-unique'
import { runFlaggedFilesMimeTypeMigration } from '@cyggie/db/sqlite/migrations/083-flagged-files-mime-type'
import { runRepairBadPrimaryDomainsMigration } from '@cyggie/db/sqlite/migrations/084-repair-bad-primary-domains'
import { runMemoEvidenceMigration } from '@cyggie/db/sqlite/migrations/085-memo-evidence'
import { runAgentRunsMigration } from '@cyggie/db/sqlite/migrations/086-agent-runs'
import { runAgentRunEventsMigration } from '@cyggie/db/sqlite/migrations/087-agent-run-events'
import { runPortfolioStageBackfillMigration } from '@cyggie/db/sqlite/migrations/088-portfolio-stage-backfill'
import { runTranscriptSummariesMigration } from '@cyggie/db/sqlite/migrations/089-transcript-summaries'
import { runMemoEvidenceSectionMigration } from '@cyggie/db/sqlite/migrations/090-memo-evidence-section'
import { runAgentRunsCacheTokensMigration } from '@cyggie/db/sqlite/migrations/091-agent-runs-cache-tokens'
import { runStressTestReportsMigration } from '@cyggie/db/sqlite/migrations/092-stress-test-reports'
import { runStressTestReportsNoFkMigration } from '@cyggie/db/sqlite/migrations/093-stress-test-reports-no-fk'
import { runAgentRunsDropVersionFkMigration } from '@cyggie/db/sqlite/migrations/094-agent-runs-drop-version-fk'
import { runPriorityRenameFurtherWorkMigration } from '@cyggie/db/sqlite/migrations/095-priority-rename-further-work'
// Branch additions (113-117). NOTE: this fixture historically stopped at 095;
// these only depend on tables already present at that point (email tables from
// 013, contacts, org_companies, user_preferences from 043), so they apply
// cleanly without backfilling 096-112.
import { runEmailSyncLamportMigration } from '@cyggie/db/sqlite/migrations/113-email-sync-lamport'
import { runCompanyTargetInvestmentFieldsMigration } from '@cyggie/db/sqlite/migrations/114-company-target-investment-fields'
import { runContactTargetInvestmentStageMigration } from '@cyggie/db/sqlite/migrations/115-contact-target-investment-stage'
import { runDropContactInvestorStageMigration } from '@cyggie/db/sqlite/migrations/116-drop-contact-investor-stage'
import { runUserPreferencesLamportMigration } from '@cyggie/db/sqlite/migrations/117-user-preferences-lamport'
import { runNotesIsPrivateMigration } from '@cyggie/db/sqlite/migrations/121-notes-is-private'
// Phase 1/2 multiplayer — soft-delete + field-LWW columns on org_companies + tasks
// (deleted_at, field_lamports, ...). Required now that the live reads filter
// deleted_at IS NULL.
import { runOrgCompaniesFieldLwwMigration } from '@cyggie/db/sqlite/migrations/124-org-companies-field-lww'
import { runTasksFieldLwwMigration } from '@cyggie/db/sqlite/migrations/125-tasks-field-lww'
import { runTombstonesMigration } from '@cyggie/db/sqlite/migrations/126-tombstones'
import { runContactsMeetingsFirmSharedMigration } from '@cyggie/db/sqlite/migrations/128-contacts-meetings-firm-shared'

type MigrationFn = (db: Database.Database) => void

/**
 * Ordered list of every migration applied at production startup.
 * Mirrors src/main/database/connection.ts:getDatabase. When a new
 * migration is added to connection.ts, append it here too.
 */
const ALL_MIGRATIONS: MigrationFn[] = [
  runMigrations,
  runFtsMigration,
  runNotesMigration,
  runTranscriptSegmentsMigration,
  runDriveColumnsMigration,
  runAttendeesMigration,
  runChatMessagesMigration,
  runCompaniesMigration,
  runCompaniesCacheMigration,
  runClearCompanyCacheMigration,
  runRecordingPathMigration,
  runCompanyOsCoreMigration,
  runCompanyOsEmailMigration,
  runCompanyOsArtifactsMigration,
  runCompanyOsNotesMigration,
  runCompanyOsMemoMigration,
  runCompanyOsThesisMigration,
  runCompanyOsBackfillMigration,
  runCompanyClassificationMigration,
  runCompanyDomainNormalizationMigration,
  runContactMultiEmailMigration,
  runContactNamePartsMigration,
  runDataIntegrityMigration,
  runAuthFoundationMigration,
  runPipelineStagesMigration,
  runContactTypeMigration,
  runCompanyLocationMigration,
  runPipelineCompanyFieldsMigration,
  runPerformanceIndexesMigration,
  runTasksMigration,
  runUserProfileFieldsMigration,
  runUserNamePartsMigration,
  runTemplateInstructionsMigration,
  runCompanyFlaggedFilesMigration,
  runContactExtraFieldsMigration,
  runCompanyExtraFieldsMigration,
  runContactExtraFieldsV2Migration,
  runCustomFieldDefinitionsMigration,
  runCustomFieldValuesMigration,
  runContactNotesMigration,
  runMeetingNotesSourceMigration,
  runUserPreferencesMigration,
  runCompanyDecisionLogsMigration,
  runPortfolioCompanyFieldsMigration,
  runBuiltinFieldDefsMigration,
  runBackfillNormalizedNamesMigration,
  runContactFieldSourcesMigration,
  runCustomFieldSectionMigration,
  runCompanyFieldSourcesMigration,
  runContactDecisionLogsMigration,
  runUnifiedNotesMigration,
  runConvertManualNotesMigration,
  runNotesFts5Migration,
  runSpeakerContactLinksMigration,
  runCompanyNewFieldsMigration,
  runNotesFolderPathMigration,
  runNoteFoldersMigration,
  runPartnerMeetingMigration,
  runRepairOwnCompanyContactsMigration,
  runPartnerMeetingLinkedMeetingMigration,
  runRepairOwnerLinkedinUrlMigration,
  runRemoveNotificationContactsMigration,
  runCalendarEventDedupMigration,
  runRepairImportedNoteFrontmatterMigration,
  runContactLinkedinFieldsMigration,
  runRepairCompanyViewFlagMigration,
  runContactTalentPipelineMigration,
  runContactKeyTakeawaysMigration,
  runCompanyKeyTakeawaysMigration,
  runMeetingDismissedCompaniesMigration,
  runCompanyPortfolioFundMigration,
  runPortfolioInvestmentFieldsMigration,
  runBackfillCompanyDomainsMigration,
  runCompanyInvestorsPositionMigration,
  runLeadInvestorCompanyIdMigration,
  runIndustryConsolidationMigration,
  runChatSessionsMigration,
  runDropCompanyConversationsMigration,
  runBackfillMeetingChatsMigration,
  runDropLegacyNotesTablesMigration,
  runNotesSourceMeetingUniqueMigration,
  runFlaggedFilesMimeTypeMigration,
  runRepairBadPrimaryDomainsMigration,
  runMemoEvidenceMigration,
  runAgentRunsMigration,
  runAgentRunEventsMigration,
  runPortfolioStageBackfillMigration,
  runTranscriptSummariesMigration,
  runMemoEvidenceSectionMigration,
  runAgentRunsCacheTokensMigration,
  runStressTestReportsMigration,
  runStressTestReportsNoFkMigration,
  runAgentRunsDropVersionFkMigration,
  runPriorityRenameFurtherWorkMigration,
  // Branch additions (113-117) — target-investment fields + email/pref lamport.
  runEmailSyncLamportMigration,
  runCompanyTargetInvestmentFieldsMigration,
  runContactTargetInvestmentStageMigration,
  runDropContactInvestorStageMigration,
  runUserPreferencesLamportMigration,
  // is_private on notes (per-note firm-visibility override). Idempotent ALTER;
  // safe to run after the unified notes table exists.
  runNotesIsPrivateMigration,
  runOrgCompaniesFieldLwwMigration,
  runTasksFieldLwwMigration,
  runTombstonesMigration,
  runContactsMeetingsFirmSharedMigration,
]

/**
 * Build an in-memory SQLite database with the specified migrations.
 * Pass nothing (or call `buildTestDbFull()`) to apply every migration.
 * Pass a subset when you want narrower scope or want to isolate a
 * specific schema version.
 */
export function buildTestDb(opts?: { migrations?: MigrationFn[] }): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const fn of opts?.migrations ?? ALL_MIGRATIONS) {
    fn(db)
  }
  return db
}

/** Shorthand for the common case: every migration in order. */
export function buildTestDbFull(): Database.Database {
  return buildTestDb()
}

/**
 * vi.mock factory for `../main/database/repositories/notes-base`.
 *
 * Production builds entity-scoped note repos at module load via
 * `makeEntityNotesRepo('company_id'|'contact_id')`. Tests that need to
 * control the .list() return value should mock the factory itself —
 * this helper returns a stub whose .list() forwards to the caller's
 * vi.fn(). Other methods (get/listForEntities/create/update/delete)
 * are no-op vi.fn() stubs.
 *
 * Usage:
 *   import { notesBaseMockFactory } from './_fixtures/test-db'
 *   const mockListCompanyNotes = vi.fn()
 *   vi.mock('@cyggie/db/sqlite/repositories/notes-base',
 *           () => notesBaseMockFactory(mockListCompanyNotes))
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notesBaseMockFactory(listMock: (...args: unknown[]) => any) {
  return {
    makeEntityNotesRepo: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      listForEntities: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }),
  }
}
