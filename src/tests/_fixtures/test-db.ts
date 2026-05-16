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
import { runMigrations } from '../../main/database/migrations/001-initial-schema'
import { runFtsMigration } from '../../main/database/migrations/002-fts5-tables'
import { runNotesMigration } from '../../main/database/migrations/003-notes-column'
import { runTranscriptSegmentsMigration } from '../../main/database/migrations/004-transcript-segments'
import { runDriveColumnsMigration } from '../../main/database/migrations/005-drive-columns'
import { runAttendeesMigration } from '../../main/database/migrations/006-attendees-column'
import { runChatMessagesMigration } from '../../main/database/migrations/007-chat-messages'
import { runCompaniesMigration } from '../../main/database/migrations/008-companies'
import { runCompaniesCacheMigration } from '../../main/database/migrations/009-companies-cache'
import { runClearCompanyCacheMigration } from '../../main/database/migrations/010-clear-company-cache'
import { runRecordingPathMigration } from '../../main/database/migrations/011-recording-path'
import { runCompanyOsCoreMigration } from '../../main/database/migrations/012-company-os-core'
import { runCompanyOsEmailMigration } from '../../main/database/migrations/013-company-os-email'
import { runCompanyOsArtifactsMigration } from '../../main/database/migrations/014-company-os-artifacts'
import { runCompanyOsNotesMigration } from '../../main/database/migrations/016-company-os-notes'
import { runCompanyOsMemoMigration } from '../../main/database/migrations/017-company-os-memo'
import { runCompanyOsThesisMigration } from '../../main/database/migrations/018-company-os-thesis'
import { runCompanyOsBackfillMigration } from '../../main/database/migrations/019-company-os-backfill'
import { runCompanyClassificationMigration } from '../../main/database/migrations/020-company-classification'
import { runCompanyDomainNormalizationMigration } from '../../main/database/migrations/021-company-domain-normalization'
import { runContactMultiEmailMigration } from '../../main/database/migrations/022-contact-multi-email'
import { runContactNamePartsMigration } from '../../main/database/migrations/023-contact-name-parts'
import { runDataIntegrityMigration } from '../../main/database/migrations/024-data-integrity'
import { runAuthFoundationMigration } from '../../main/database/migrations/025-auth-foundation'
import { runPipelineStagesMigration } from '../../main/database/migrations/026-pipeline-stages'
import { runContactTypeMigration } from '../../main/database/migrations/027-contact-type'
import { runCompanyLocationMigration } from '../../main/database/migrations/028-company-location'
import { runPipelineCompanyFieldsMigration } from '../../main/database/migrations/029-pipeline-company-fields'
import { runPerformanceIndexesMigration } from '../../main/database/migrations/030-performance-indexes'
import { runTasksMigration } from '../../main/database/migrations/031-tasks'
import { runUserProfileFieldsMigration } from '../../main/database/migrations/032-user-profile-fields'
import { runUserNamePartsMigration } from '../../main/database/migrations/033-user-name-parts'
import { runTemplateInstructionsMigration } from '../../main/database/migrations/034-template-instructions'
import { runCompanyFlaggedFilesMigration } from '../../main/database/migrations/035-company-flagged-files'
import { runContactExtraFieldsMigration } from '../../main/database/migrations/036-contact-extra-fields'
import { runCompanyExtraFieldsMigration } from '../../main/database/migrations/037-company-extra-fields'
import { runContactExtraFieldsV2Migration } from '../../main/database/migrations/038-contact-extra-fields-v2'
import { runCustomFieldDefinitionsMigration } from '../../main/database/migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from '../../main/database/migrations/040-custom-field-values'
import { runContactNotesMigration } from '../../main/database/migrations/041-contact-notes'
import { runMeetingNotesSourceMigration } from '../../main/database/migrations/042-meeting-notes-source'
import { runUserPreferencesMigration } from '../../main/database/migrations/043-user-preferences'
import { runCompanyDecisionLogsMigration } from '../../main/database/migrations/044-company-decision-logs'
import { runPortfolioCompanyFieldsMigration } from '../../main/database/migrations/045-portfolio-company-fields'
import { runBuiltinFieldDefsMigration } from '../../main/database/migrations/046-builtin-field-defs'
import { runBackfillNormalizedNamesMigration } from '../../main/database/migrations/047-backfill-normalized-names'
import { runContactFieldSourcesMigration } from '../../main/database/migrations/048-contact-field-sources'
import { runCustomFieldSectionMigration } from '../../main/database/migrations/049-custom-field-section'
import { runCompanyFieldSourcesMigration } from '../../main/database/migrations/050-company-field-sources'
import { runContactDecisionLogsMigration } from '../../main/database/migrations/051-contact-decision-logs'
import { runUnifiedNotesMigration } from '../../main/database/migrations/052-unified-notes'
import { runConvertManualNotesMigration } from '../../main/database/migrations/053-convert-manual-notes'
import { runNotesFts5Migration } from '../../main/database/migrations/054-notes-fts5'
import { runSpeakerContactLinksMigration } from '../../main/database/migrations/055-speaker-contact-links'
import { runCompanyNewFieldsMigration } from '../../main/database/migrations/056-company-new-fields'
import { runNotesFolderPathMigration } from '../../main/database/migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from '../../main/database/migrations/058-note-folders'
import { runPartnerMeetingMigration } from '../../main/database/migrations/059-partner-meeting'
import { runRepairOwnCompanyContactsMigration } from '../../main/database/migrations/060-repair-own-company-contacts'
import { runPartnerMeetingLinkedMeetingMigration } from '../../main/database/migrations/061-partner-meeting-linked-meeting'
import { runRepairOwnerLinkedinUrlMigration } from '../../main/database/migrations/062-repair-owner-linkedin-url'
import { runRemoveNotificationContactsMigration } from '../../main/database/migrations/063-remove-notification-contacts'
import { runCalendarEventDedupMigration } from '../../main/database/migrations/064-calendar-event-dedup'
import { runRepairImportedNoteFrontmatterMigration } from '../../main/database/migrations/065-repair-imported-note-frontmatter'
import { runContactLinkedinFieldsMigration } from '../../main/database/migrations/066-contact-linkedin-fields'
import { runRepairCompanyViewFlagMigration } from '../../main/database/migrations/067-repair-company-view-flag'
import { runContactTalentPipelineMigration } from '../../main/database/migrations/068-contact-talent-pipeline'
import { runContactKeyTakeawaysMigration } from '../../main/database/migrations/069-contact-key-takeaways'
import { runCompanyKeyTakeawaysMigration } from '../../main/database/migrations/070-company-key-takeaways'
import { runMeetingDismissedCompaniesMigration } from '../../main/database/migrations/071-meeting-dismissed-companies'
import { runCompanyPortfolioFundMigration } from '../../main/database/migrations/072-company-portfolio-fund'
import { runPortfolioInvestmentFieldsMigration } from '../../main/database/migrations/073-portfolio-investment-fields'
import { runBackfillCompanyDomainsMigration } from '../../main/database/migrations/074-backfill-company-domains'
import { runCompanyInvestorsPositionMigration } from '../../main/database/migrations/075-company-investors-position'
import { runLeadInvestorCompanyIdMigration } from '../../main/database/migrations/076-lead-investor-company-id'
import { runIndustryConsolidationMigration } from '../../main/database/migrations/077-industry-consolidation'
import { runChatSessionsMigration } from '../../main/database/migrations/078-chat-sessions'
import { runDropCompanyConversationsMigration } from '../../main/database/migrations/079-drop-company-conversations'
import { runBackfillMeetingChatsMigration } from '../../main/database/migrations/080-backfill-meeting-chats'
import { runDropLegacyNotesTablesMigration } from '../../main/database/migrations/081-drop-legacy-notes-tables'
import { runNotesSourceMeetingUniqueMigration } from '../../main/database/migrations/082-notes-source-meeting-unique'
import { runFlaggedFilesMimeTypeMigration } from '../../main/database/migrations/083-flagged-files-mime-type'
import { runRepairBadPrimaryDomainsMigration } from '../../main/database/migrations/084-repair-bad-primary-domains'
import { runMemoEvidenceMigration } from '../../main/database/migrations/085-memo-evidence'
import { runAgentRunsMigration } from '../../main/database/migrations/086-agent-runs'
import { runAgentRunEventsMigration } from '../../main/database/migrations/087-agent-run-events'
import { runPortfolioStageBackfillMigration } from '../../main/database/migrations/088-portfolio-stage-backfill'
import { runTranscriptSummariesMigration } from '../../main/database/migrations/089-transcript-summaries'
import { runMemoEvidenceSectionMigration } from '../../main/database/migrations/090-memo-evidence-section'
import { runAgentRunsCacheTokensMigration } from '../../main/database/migrations/091-agent-runs-cache-tokens'
import { runStressTestReportsMigration } from '../../main/database/migrations/092-stress-test-reports'
import { runStressTestReportsNoFkMigration } from '../../main/database/migrations/093-stress-test-reports-no-fk'
import { runAgentRunsDropVersionFkMigration } from '../../main/database/migrations/094-agent-runs-drop-version-fk'
import { runPriorityRenameFurtherWorkMigration } from '../../main/database/migrations/095-priority-rename-further-work'

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
