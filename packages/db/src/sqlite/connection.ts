import Database from 'better-sqlite3'
import { getDatabasePath } from '@main/storage/paths'
import { runMigrations } from './migrations/001-initial-schema'
import { runFtsMigration } from './migrations/002-fts5-tables'
import { runNotesMigration } from './migrations/003-notes-column'
import { runTranscriptSegmentsMigration } from './migrations/004-transcript-segments'
import { runDriveColumnsMigration } from './migrations/005-drive-columns'
import { runAttendeesMigration } from './migrations/006-attendees-column'
import { runChatMessagesMigration } from './migrations/007-chat-messages'
import { runCompaniesMigration } from './migrations/008-companies'
import { runCompaniesCacheMigration } from './migrations/009-companies-cache'
import { runClearCompanyCacheMigration } from './migrations/010-clear-company-cache'
import { runRecordingPathMigration } from './migrations/011-recording-path'
import { runCompanyOsCoreMigration } from './migrations/012-company-os-core'
import { runCompanyOsEmailMigration } from './migrations/013-company-os-email'
import { runCompanyOsArtifactsMigration } from './migrations/014-company-os-artifacts'
import { runCompanyOsNotesMigration } from './migrations/016-company-os-notes'
import { runCompanyOsMemoMigration } from './migrations/017-company-os-memo'
import { runCompanyOsThesisMigration } from './migrations/018-company-os-thesis'
import { runCompanyOsBackfillMigration } from './migrations/019-company-os-backfill'
import { runCompanyClassificationMigration } from './migrations/020-company-classification'
import { runCompanyDomainNormalizationMigration } from './migrations/021-company-domain-normalization'
import { runContactMultiEmailMigration } from './migrations/022-contact-multi-email'
import { runContactNamePartsMigration } from './migrations/023-contact-name-parts'
import { runDataIntegrityMigration } from './migrations/024-data-integrity'
import { runAuthFoundationMigration } from './migrations/025-auth-foundation'
import { runPipelineStagesMigration } from './migrations/026-pipeline-stages'
import { runContactTypeMigration } from './migrations/027-contact-type'
import { runCompanyLocationMigration } from './migrations/028-company-location'
import { runPipelineCompanyFieldsMigration } from './migrations/029-pipeline-company-fields'
import { runPerformanceIndexesMigration } from './migrations/030-performance-indexes'
import { runTasksMigration } from './migrations/031-tasks'
import { runUserProfileFieldsMigration } from './migrations/032-user-profile-fields'
import { runUserNamePartsMigration } from './migrations/033-user-name-parts'
import { runTemplateInstructionsMigration } from './migrations/034-template-instructions'
import { runCompanyFlaggedFilesMigration } from './migrations/035-company-flagged-files'
import { runContactExtraFieldsMigration } from './migrations/036-contact-extra-fields'
import { runCompanyExtraFieldsMigration } from './migrations/037-company-extra-fields'
import { runContactExtraFieldsV2Migration } from './migrations/038-contact-extra-fields-v2'
import { runCustomFieldDefinitionsMigration } from './migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from './migrations/040-custom-field-values'
import { runContactNotesMigration } from './migrations/041-contact-notes'
import { runMeetingNotesSourceMigration } from './migrations/042-meeting-notes-source'
import { runUserPreferencesMigration } from './migrations/043-user-preferences'
import { runCompanyDecisionLogsMigration } from './migrations/044-company-decision-logs'
import { runPortfolioCompanyFieldsMigration } from './migrations/045-portfolio-company-fields'
import { runBuiltinFieldDefsMigration } from './migrations/046-builtin-field-defs'
import { runBackfillNormalizedNamesMigration } from './migrations/047-backfill-normalized-names'
import { runContactFieldSourcesMigration } from './migrations/048-contact-field-sources'
import { runCustomFieldSectionMigration } from './migrations/049-custom-field-section'
import { runCompanyFieldSourcesMigration } from './migrations/050-company-field-sources'
import { runContactDecisionLogsMigration } from './migrations/051-contact-decision-logs'
import { runUnifiedNotesMigration } from './migrations/052-unified-notes'
import { runConvertManualNotesMigration } from './migrations/053-convert-manual-notes'
import { runNotesFts5Migration } from './migrations/054-notes-fts5'
import { runSpeakerContactLinksMigration } from './migrations/055-speaker-contact-links'
import { runCompanyNewFieldsMigration } from './migrations/056-company-new-fields'
import { runNotesFolderPathMigration } from './migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from './migrations/058-note-folders'
import { runPartnerMeetingMigration } from './migrations/059-partner-meeting'
import { runRepairOwnCompanyContactsMigration } from './migrations/060-repair-own-company-contacts'
import { runPartnerMeetingLinkedMeetingMigration } from './migrations/061-partner-meeting-linked-meeting'
import { runRepairOwnerLinkedinUrlMigration } from './migrations/062-repair-owner-linkedin-url'
import { runRemoveNotificationContactsMigration } from './migrations/063-remove-notification-contacts'
import { runCalendarEventDedupMigration } from './migrations/064-calendar-event-dedup'
import { runRepairImportedNoteFrontmatterMigration } from './migrations/065-repair-imported-note-frontmatter'
import { runContactLinkedinFieldsMigration } from './migrations/066-contact-linkedin-fields'
import { runRepairCompanyViewFlagMigration } from './migrations/067-repair-company-view-flag'
import { runContactTalentPipelineMigration } from './migrations/068-contact-talent-pipeline'
import { runContactKeyTakeawaysMigration } from './migrations/069-contact-key-takeaways'
import { runCompanyKeyTakeawaysMigration } from './migrations/070-company-key-takeaways'
import { runMeetingDismissedCompaniesMigration } from './migrations/071-meeting-dismissed-companies'
import { runCompanyPortfolioFundMigration } from './migrations/072-company-portfolio-fund'
import { runPortfolioInvestmentFieldsMigration } from './migrations/073-portfolio-investment-fields'
import { runBackfillCompanyDomainsMigration } from './migrations/074-backfill-company-domains'
import { runCompanyInvestorsPositionMigration } from './migrations/075-company-investors-position'
import { runLeadInvestorCompanyIdMigration } from './migrations/076-lead-investor-company-id'
import { runIndustryConsolidationMigration } from './migrations/077-industry-consolidation'
import { runChatSessionsMigration } from './migrations/078-chat-sessions'
import { runDropCompanyConversationsMigration } from './migrations/079-drop-company-conversations'
import { runBackfillMeetingChatsMigration } from './migrations/080-backfill-meeting-chats'
import { runDropLegacyNotesTablesMigration } from './migrations/081-drop-legacy-notes-tables'
import { runNotesSourceMeetingUniqueMigration } from './migrations/082-notes-source-meeting-unique'
import { runFlaggedFilesMimeTypeMigration } from './migrations/083-flagged-files-mime-type'
import { runRepairBadPrimaryDomainsMigration } from './migrations/084-repair-bad-primary-domains'
import { runMemoEvidenceMigration } from './migrations/085-memo-evidence'
import { runAgentRunsMigration } from './migrations/086-agent-runs'
import { runAgentRunEventsMigration } from './migrations/087-agent-run-events'
import { runPortfolioStageBackfillMigration } from './migrations/088-portfolio-stage-backfill'
import { runTranscriptSummariesMigration } from './migrations/089-transcript-summaries'
import { runMemoEvidenceSectionMigration } from './migrations/090-memo-evidence-section'
import { runAgentRunsCacheTokensMigration } from './migrations/091-agent-runs-cache-tokens'
import { runStressTestReportsMigration } from './migrations/092-stress-test-reports'
import { runStressTestReportsNoFkMigration } from './migrations/093-stress-test-reports-no-fk'
import { runAgentRunsDropVersionFkMigration } from './migrations/094-agent-runs-drop-version-fk'
import { runPriorityRenameFurtherWorkMigration } from './migrations/095-priority-rename-further-work'
import { runLamportOnOwnedTablesMigration } from './migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from './migrations/097-sync-outbox-state'
import { runGroupEventAndTombstonesMigration } from './migrations/098-group-event-and-tombstones'
import { runMeetingsSummaryTextMigration } from './migrations/099-meetings-summary-text'
import { runSyncStateSafeBatchSizeMigration } from './migrations/100-sync-state-safe-batch-size'
import { runMemoSyncLamportMigration } from './migrations/101-memo-sync-lamport'
import { runChatSessionSelectedCompaniesMigration } from './migrations/102-chat-session-selected-companies'
import { runChatSessionCacheEnabledMigration } from './migrations/103-chat-session-cache-enabled'
import { runFlaggedFilesExtractionMigration } from './migrations/104-flagged-files-extraction'
import { runOrgCompaniesPassedFromStageMigration } from './migrations/105-org-companies-passed-from-stage'
import { runDefaultTemplatesAttendeesPlaceholderMigration } from './migrations/106-default-templates-attendees-placeholder'
import { runMeetingsSelfNameMigration } from './migrations/107-meetings-self-name'
import { runContactsAddressMigration } from './migrations/108-contacts-address'
import { runContactKeyTakeawaysUserNoteMigration } from './migrations/109-contact-key-takeaways-user-note'
import { runCompanyKeyTakeawaysUserNoteMigration } from './migrations/110-company-key-takeaways-user-note'
import { runMeetingsTranscriptProviderMigration } from './migrations/111-meetings-transcript-provider'
import { runMeetingsMeSpeakerIndexMigration } from './migrations/112-meetings-me-speaker-index'

let db: Database.Database | null = null

const SLOW_QUERY_MS = 20

function instrumentDatabase(database: Database.Database): void {
  if (!import.meta.env.DEV) return
  const originalPrepare = database.prepare.bind(database)
  database.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql)
    const time = <Args extends unknown[], R>(method: 'run' | 'get' | 'all' | 'iterate', fn: (...args: Args) => R) =>
      function (this: unknown, ...args: Args): R {
        const start = performance.now()
        try {
          return fn.apply(stmt, args) as R
        } finally {
          const ms = performance.now() - start
          if (ms >= SLOW_QUERY_MS) {
            const trimmed = sql.replace(/\s+/g, ' ').trim().slice(0, 120)
            console.warn(`[sql-perf] ${method} ${ms.toFixed(1)}ms — ${trimmed}`)
          }
        }
      }
    stmt.run = time('run', stmt.run.bind(stmt)) as typeof stmt.run
    stmt.get = time('get', stmt.get.bind(stmt)) as typeof stmt.get
    stmt.all = time('all', stmt.all.bind(stmt)) as typeof stmt.all
    stmt.iterate = time('iterate', stmt.iterate.bind(stmt)) as typeof stmt.iterate
    return stmt
  }) as typeof database.prepare
}

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(getDatabasePath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    instrumentDatabase(db)
    runMigrations(db)
    runFtsMigration(db)
    runNotesMigration(db)
    runTranscriptSegmentsMigration(db)
    runDriveColumnsMigration(db)
    runAttendeesMigration(db)
    runChatMessagesMigration(db)
    runCompaniesMigration(db)
    runCompaniesCacheMigration(db)
    runClearCompanyCacheMigration(db)
    runRecordingPathMigration(db)
    runCompanyOsCoreMigration(db)
    runCompanyOsEmailMigration(db)
    runCompanyOsArtifactsMigration(db)
    // Migration 015 removed: company_conversations was never wired to the renderer; tables dropped by migration 079.
    runCompanyOsNotesMigration(db)
    runCompanyOsMemoMigration(db)
    runCompanyOsThesisMigration(db)
    runCompanyOsBackfillMigration(db)
    runCompanyClassificationMigration(db)
    runCompanyDomainNormalizationMigration(db)
    runContactMultiEmailMigration(db)
    runContactNamePartsMigration(db)
    runDataIntegrityMigration(db)
    runAuthFoundationMigration(db)
    runPipelineStagesMigration(db)
    runContactTypeMigration(db)
    runCompanyLocationMigration(db)
    runPipelineCompanyFieldsMigration(db)
    runPerformanceIndexesMigration(db)
    runTasksMigration(db)
    runUserProfileFieldsMigration(db)
    runUserNamePartsMigration(db)
    runTemplateInstructionsMigration(db)
    runCompanyFlaggedFilesMigration(db)
    runContactExtraFieldsMigration(db)
    runCompanyExtraFieldsMigration(db)
    runContactExtraFieldsV2Migration(db)
    runCustomFieldDefinitionsMigration(db)
    runCustomFieldValuesMigration(db)
    runContactNotesMigration(db)
    runMeetingNotesSourceMigration(db)
    runUserPreferencesMigration(db)
    runCompanyDecisionLogsMigration(db)
    runPortfolioCompanyFieldsMigration(db)
    runBuiltinFieldDefsMigration(db)
    runBackfillNormalizedNamesMigration(db)
    runContactFieldSourcesMigration(db)
    runCustomFieldSectionMigration(db)
    runCompanyFieldSourcesMigration(db)
    runContactDecisionLogsMigration(db)
    runUnifiedNotesMigration(db)
    runConvertManualNotesMigration(db)
    runNotesFts5Migration(db)
    runSpeakerContactLinksMigration(db)
    runCompanyNewFieldsMigration(db)
    runNotesFolderPathMigration(db)
    runNoteFoldersMigration(db)
    runPartnerMeetingMigration(db)
    runRepairOwnCompanyContactsMigration(db)
    runPartnerMeetingLinkedMeetingMigration(db)
    runRepairOwnerLinkedinUrlMigration(db)
    runRemoveNotificationContactsMigration(db)
    runCalendarEventDedupMigration(db)
    runRepairImportedNoteFrontmatterMigration(db)
    runContactLinkedinFieldsMigration(db)
    runRepairCompanyViewFlagMigration(db)
    runContactTalentPipelineMigration(db)
    runContactKeyTakeawaysMigration(db)
    runCompanyKeyTakeawaysMigration(db)
    runMeetingDismissedCompaniesMigration(db)
    runCompanyPortfolioFundMigration(db)
    runPortfolioInvestmentFieldsMigration(db)
    runBackfillCompanyDomainsMigration(db)
    runCompanyInvestorsPositionMigration(db)
    runLeadInvestorCompanyIdMigration(db)
    runIndustryConsolidationMigration(db)
    runChatSessionsMigration(db)
    runDropCompanyConversationsMigration(db)
    runBackfillMeetingChatsMigration(db)
    runDropLegacyNotesTablesMigration(db)
    runNotesSourceMeetingUniqueMigration(db)
    runFlaggedFilesMimeTypeMigration(db)
    runRepairBadPrimaryDomainsMigration(db)
    runMemoEvidenceMigration(db)
    runAgentRunsMigration(db)
    runAgentRunEventsMigration(db)
    runPortfolioStageBackfillMigration(db)
    runTranscriptSummariesMigration(db)
    runMemoEvidenceSectionMigration(db)
    runAgentRunsCacheTokensMigration(db)
    runStressTestReportsMigration(db)
    runStressTestReportsNoFkMigration(db)
    runAgentRunsDropVersionFkMigration(db)
    runPriorityRenameFurtherWorkMigration(db)
    runLamportOnOwnedTablesMigration(db)
    runSyncOutboxStateMigration(db)
    runGroupEventAndTombstonesMigration(db)
    runMeetingsSummaryTextMigration(db)
    runSyncStateSafeBatchSizeMigration(db)
    runMemoSyncLamportMigration(db)
    runChatSessionSelectedCompaniesMigration(db)
    runChatSessionCacheEnabledMigration(db)
    runFlaggedFilesExtractionMigration(db)
    runOrgCompaniesPassedFromStageMigration(db)
    runDefaultTemplatesAttendeesPlaceholderMigration(db)
    runMeetingsSelfNameMigration(db)
    runContactsAddressMigration(db)
    runContactKeyTakeawaysUserNoteMigration(db)
    runCompanyKeyTakeawaysUserNoteMigration(db)
    runMeetingsTranscriptProviderMigration(db)
    runMeetingsMeSpeakerIndexMigration(db)

    // Orphan-run garbage collection: any agent_runs row stuck at status='running'
    // older than the threshold was abandoned by a prior app session (crash or
    // forced quit). Flip to 'orphaned' so it doesn't block in-flight UI gates.
    const gcd = gcOrphanedRuns(db)
    if (gcd > 0) console.log(`[agent-runs] orphan GC marked ${gcd} stuck run(s) as orphaned`)
  }
  return db
}

/**
 * Inline orphan-GC. Lives here (rather than imported from run-store.ts) to
 * avoid a circular `getDatabase` reference during the very first connection
 * — the run-store version calls getDatabase() which would re-enter this
 * function. At launch we already hold `db`, so we can act on it directly.
 */
function gcOrphanedRuns(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE agent_runs
       SET status = 'orphaned',
           ended_at = datetime('now'),
           error_class = 'OrphanedAtLaunch',
           error_message = 'app exited or crashed during run'
     WHERE status = 'running'
       AND datetime(started_at) < datetime('now', '-30 minutes')
  `).run()
  return result.changes ?? 0
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
