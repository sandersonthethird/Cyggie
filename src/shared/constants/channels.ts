export const IPC_CHANNELS = {
  // Meeting operations
  MEETING_LIST: 'meeting:list',
  MEETING_GET: 'meeting:get',
  MEETING_DELETE: 'meeting:delete',
  MEETING_UPDATE: 'meeting:update',
  MEETING_TAG_SPEAKER_CONTACT: 'meeting:tag-speaker-contact',
  MEETING_LINK_EXISTING_COMPANY: 'meeting:link-existing-company',
  MEETING_UNLINK_COMPANY: 'meeting:unlink-company',
  MEETING_SWAP_COMPANY: 'meeting:swap-company',

  // Recording
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  RECORDING_PAUSE: 'recording:pause',
  RECORDING_RESUME: 'recording:resume',
  RECORDING_STATUS: 'recording:status',
  RECORDING_TRANSCRIPT_UPDATE: 'recording:transcript-update',
  RECORDING_ERROR: 'recording:error',
  RECORDING_AUTO_STOP: 'recording:auto-stop',
  RECORDING_SYSTEM_AUDIO_STATUS: 'recording:system-audio-status',
  // Broadcast events fired by the main process when background transcript
  // finalization (after RECORDING_STOP returns optimistically) completes or
  // fails. Mirrors VIDEO_FINALIZED / VIDEO_FINALIZE_ERROR.
  RECORDING_FINALIZED: 'recording:finalized',
  RECORDING_FINALIZE_ERROR: 'recording:finalize-error',
  RECORDING_AUDIO_FLOW_STATUS: 'recording:audio-flow-status',
  RECORDING_MIC_STATUS: 'recording:mic-status',

  // Calendar
  CALENDAR_CONNECT: 'calendar:connect',
  CALENDAR_DISCONNECT: 'calendar:disconnect',
  CALENDAR_EVENTS: 'calendar:events',
  CALENDAR_EVENTS_RANGE: 'calendar:events-range',
  CALENDAR_SYNC: 'calendar:sync',
  CALENDAR_IS_CONNECTED: 'calendar:is-connected',
  CALENDAR_REAUTHORIZE: 'calendar:reauthorize',
  // Bypasses both cache layers (in-session ipcCache + persistent disk cache)
  // and fetches fresh from Google. Used by the 5-min polling loop and any
  // manual-refresh path.
  CALENDAR_REFRESH: 'calendar:refresh',

  // Gmail
  GMAIL_CONNECT: 'gmail:connect',
  GMAIL_DISCONNECT: 'gmail:disconnect',
  GMAIL_IS_CONNECTED: 'gmail:is-connected',

  // Google account
  GOOGLE_ACCOUNT_EMAILS: 'google:account-emails',

  // Search
  SEARCH_QUERY: 'search:query',
  SEARCH_ADVANCED: 'search:advanced',
  SEARCH_ALL_SPEAKERS: 'search:all-speakers',
  SEARCH_SUGGEST: 'search:suggest',
  SEARCH_CATEGORIZED: 'search:categorized',

  // Company enrichment
  COMPANY_ENRICH_MEETING: 'company:enrich-meeting',
  COMPANY_GET_SUGGESTIONS: 'company:get-suggestions',
  COMPANY_LIST: 'company:list',
  COMPANY_COUNT_STUBS: 'company:count-stubs',
  COMPANY_GET: 'company:get',
  COMPANY_CREATE: 'company:create',
  COMPANY_UPDATE: 'company:update',
  COMPANY_MERGE: 'company:merge',
  COMPANY_MERGE_PREVIEW: 'company:merge-preview',
  COMPANY_DEDUP_SUSPECTED: 'company:dedup-suspected',
  COMPANY_DEDUP_APPLY: 'company:dedup-apply',
  COMPANY_DELETE: 'company:delete',
  COMPANY_TAG_FROM_MEETING: 'company:tag-from-meeting',
  COMPANY_FIND_OR_CREATE: 'company:find-or-create',
  COMPANY_MEETINGS: 'company:meetings',
  COMPANY_CONTACTS: 'company:contacts',
  COMPANY_EMAILS: 'company:emails',
  COMPANY_FIX_CONCATENATED_NAMES: 'company:fix-concatenated-names',
  COMPANY_EMAIL_INGEST: 'company:email-ingest',
  COMPANY_EMAIL_INGEST_PROGRESS: 'company:email-ingest:progress',
  COMPANY_EMAIL_INGEST_CANCEL: 'company:email-ingest:cancel',
  COMPANY_EMAIL_UNLINK: 'company:email-unlink',
  COMPANY_FILES: 'company:files',
  COMPANY_FILES_READABLE: 'company:files-readable',
  // Capability-scoped file read: takes a flagged-file id, not a raw path.
  // Main looks up `company_flagged_files`; auto-flags if a companyId is
  // provided and the id isn't already flagged. See src/main/ipc/file.ipc.ts.
  // Replaces the old FILE_READ_CONTENT(arbitrary-path) channel (removed in PR2).
  FILE_READ_BY_FLAGGED_ID: 'file:read-by-flagged-id',
  COMPANY_TIMELINE: 'company:timeline',
  COMPANY_MEETING_SUMMARIES: 'company:meeting-summaries',
  COMPANY_SET_PRIMARY_CONTACT: 'company:set-primary-contact',
  COMPANY_CLEAR_PRIMARY_CONTACT: 'company:clear-primary-contact',
  COMPANY_LINK_CONTACT: 'company:link-contact',
  COMPANY_UNLINK_CONTACT: 'company:unlink-contact',

  // Contacts
  CONTACT_LIST: 'contact:list',
  CONTACT_GET: 'contact:get',
  CONTACT_EMAILS: 'contact:emails',
  CONTACT_EMAIL_INGEST: 'contact:email-ingest',
  CONTACT_EMAIL_INGEST_PROGRESS: 'contact:email-ingest:progress',
  CONTACT_EMAIL_INGEST_CANCEL: 'contact:email-ingest:cancel',
  CONTACT_CREATE: 'contact:create',
  CONTACT_ADD_EMAIL: 'contact:add-email',
  CONTACT_UPDATE_EMAIL: 'contact:update-email',
  CONTACT_REMOVE_EMAIL: 'contact:remove-email',
  CONTACT_SET_COMPANY: 'contact:set-company',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_DELETE: 'contact:delete',
  CONTACT_SYNC_FROM_MEETINGS: 'contact:sync-from-meetings',
  CONTACT_ENRICH_EXISTING: 'contact:enrich-existing',
  CONTACT_ENRICH_ONE: 'contact:enrich-one',
  CONTACT_ENRICH_LINKEDIN: 'contact:enrich-linkedin',
  CONTACT_LINKEDIN_OPEN_LOGIN: 'contact:linkedin-open-login',
  CONTACT_ENRICH_LINKEDIN_BATCH: 'contact:enrich-linkedin-batch',
  CONTACT_ENRICH_LINKEDIN_BATCH_PROGRESS: 'contact:linkedin-batch-progress',
  CONTACT_ENRICH_LINKEDIN_BATCH_CANCEL: 'contact:enrich-linkedin-batch-cancel',
  CONTACT_FIND_LINKEDIN_URL: 'contact:find-linkedin-url',
  CONTACT_FIND_LINKEDIN_URL_BATCH: 'contact:find-linkedin-url-batch',
  CONTACT_FIND_LINKEDIN_URL_BATCH_CANCEL: 'contact:find-linkedin-url-batch-cancel',
  CONTACT_FIND_LINKEDIN_URL_BATCH_PROGRESS: 'contact:find-linkedin-url-batch-progress',
  CONTACT_ONBOARD_FROM_EMAIL: 'contact:onboard-from-email',
  CONTACT_ONBOARD_PROGRESS: 'contact:onboard-progress',
  CONTACT_RESOLVE_EMAILS: 'contact:resolve-emails',
  CONTACT_DEDUP_SUSPECTED: 'contact:dedup-suspected',
  CONTACT_DEDUP_APPLY: 'contact:dedup-apply',
  CONTACT_MERGE: 'contact:merge',
  CONTACT_TIMELINE: 'contact:timeline',
  CONTACT_KEY_TAKEAWAYS_GENERATE: 'contact:key-takeaways-generate',
  CONTACT_KEY_TAKEAWAYS_PROGRESS: 'contact:key-takeaways-progress',
  COMPANY_KEY_TAKEAWAYS_GENERATE: 'company:key-takeaways-generate',
  COMPANY_KEY_TAKEAWAYS_PROGRESS: 'company:key-takeaways-progress',

  // Dashboard
  DASHBOARD_GET: 'dashboard:get',
  DASHBOARD_ENRICH_CALENDAR: 'dashboard:enrich-calendar',

  // Pipeline
  PIPELINE_LIST: 'pipeline:list',

  // Unified Ask
  UNIFIED_SEARCH_QUERY: 'unified-search:query',
  UNIFIED_SEARCH_ANSWER: 'unified-search:answer',

  // Company notes
  COMPANY_NOTES_LIST: 'company-notes:list',
  COMPANY_NOTES_GET: 'company-notes:get',
  COMPANY_NOTES_CREATE: 'company-notes:create',
  COMPANY_NOTES_UPDATE: 'company-notes:update',
  COMPANY_NOTES_DELETE: 'company-notes:delete',

  // Contact notes
  CONTACT_NOTES_LIST: 'contact-notes:list',
  CONTACT_NOTES_GET: 'contact-notes:get',
  CONTACT_NOTES_CREATE: 'contact-notes:create',
  CONTACT_NOTES_UPDATE: 'contact-notes:update',
  CONTACT_NOTES_DELETE: 'contact-notes:delete',

  // Standalone notes (unified)
  NOTES_LIST: 'notes:list',
  NOTES_GET: 'notes:get',
  NOTES_CREATE: 'notes:create',
  NOTES_UPDATE: 'notes:update',
  NOTES_DELETE: 'notes:delete',
  NOTES_SUGGEST_TAG: 'notes:suggest-tag',
  NOTES_IMPORT_FOLDER: 'notes:import-folder',
  NOTES_IMPORT_SCAN: 'notes:import-scan',
  NOTES_IMPORT_PROGRESS: 'notes:import-progress',
  NOTES_IMPORT_CANCEL: 'notes:import-cancel',
  NOTES_LIST_FOLDERS: 'notes:list-folders',
  NOTES_LIST_IMPORT_SOURCES: 'notes:list-import-sources',
  NOTES_FOLDER_TAG_SUGGESTION: 'notes:folder-tag-suggestion',
  NOTES_FOLDER_CREATE: 'notes:folder-create',
  NOTES_FOLDER_RENAME: 'notes:folder-rename',
  NOTES_FOLDER_DELETE: 'notes:folder-delete',
  NOTES_FOLDER_COUNTS: 'notes:folder-counts',

  // Contact decision log
  CONTACT_DECISION_LOG_LIST: 'contact-decision-log:list',
  CONTACT_DECISION_LOG_GET: 'contact-decision-log:get',
  CONTACT_DECISION_LOG_CREATE: 'contact-decision-log:create',
  CONTACT_DECISION_LOG_UPDATE: 'contact-decision-log:update',
  CONTACT_DECISION_LOG_DELETE: 'contact-decision-log:delete',

  // Company decision log
  COMPANY_DECISION_LOG_LIST: 'company-decision-log:list',
  COMPANY_DECISION_LOG_GET: 'company-decision-log:get',
  COMPANY_DECISION_LOG_GET_LATEST: 'company-decision-log:get-latest',
  COMPANY_DECISION_LOG_CREATE: 'company-decision-log:create',
  COMPANY_DECISION_LOG_UPDATE: 'company-decision-log:update',
  COMPANY_DECISION_LOG_DELETE: 'company-decision-log:delete',

  // Email detail
  EMAIL_GET: 'email:get',

  // Company chat
  COMPANY_CHAT_QUERY: 'company:chat-query',
  COMPANY_CHAT_ABORT: 'company-chat:abort',

  // Chat session history (persistent chats with FTS5 search)
  CHAT_SESSION_LIST_RECENT: 'chat-session:list-recent',
  CHAT_SESSION_GET_FOR_CONTEXT: 'chat-session:get-for-context',
  CHAT_SESSION_LOAD_MESSAGES: 'chat-session:load-messages',
  CHAT_SESSION_SEARCH: 'chat-session:search',
  CHAT_SESSION_END_ACTIVE: 'chat-session:end-active',
  CHAT_SESSION_CREATE_NEW: 'chat-session:create-new',
  CHAT_SESSION_RENAME: 'chat-session:rename',
  CHAT_SESSION_PIN: 'chat-session:pin',
  CHAT_SESSION_UNPIN: 'chat-session:unpin',
  CHAT_SESSION_ARCHIVE: 'chat-session:archive',
  CHAT_SESSION_DELETE: 'chat-session:delete',
  CHAT_SESSION_APPEND_MODAL_TURN: 'chat-session:append-modal-turn',

  // Contact chat
  CONTACT_CHAT_QUERY: 'contact-chat:query',
  CONTACT_CHAT_ABORT: 'contact-chat:abort',

  // Company file flags (for chat context)
  COMPANY_FILE_FLAG_GET: 'company:file-flag-get',
  COMPANY_FILE_FLAG_TOGGLE: 'company:file-flag-toggle',

  // Investment memo
  INVESTMENT_MEMO_GET_OR_CREATE: 'investment-memo:get-or-create',
  INVESTMENT_MEMO_LIST_VERSIONS: 'investment-memo:list-versions',
  INVESTMENT_MEMO_GET_VERSION: 'investment-memo:get-version',
  INVESTMENT_MEMO_SAVE_VERSION: 'investment-memo:save-version',
  INVESTMENT_MEMO_SET_STATUS: 'investment-memo:set-status',
  INVESTMENT_MEMO_EXPORT_PDF: 'investment-memo:export-pdf',
  INVESTMENT_MEMO_EXPORT_GOOGLE_DOC: 'investment-memo:export-google-doc',
  INVESTMENT_MEMO_GENERATE: 'investment-memo:generate',
  INVESTMENT_MEMO_GENERATE_PROGRESS: 'investment-memo:generate-progress',
  INVESTMENT_MEMO_SHARE_LINK: 'investment-memo:share-link',
  INVESTMENT_MEMO_REVOKE_SHARE: 'investment-memo:revoke-share',

  // Thesis Stress-Test Agent (multi-turn adversarial agent)
  THESIS_STRESS_TEST_START: 'thesis-stress-test:start',
  THESIS_STRESS_TEST_ABORT: 'thesis-stress-test:abort',
  THESIS_STRESS_TEST_PROGRESS: 'thesis-stress-test:progress',

  // Stress-test Reports (read-only Phase 1)
  STRESS_TEST_REPORT_LIST: 'stress-test-report:list',
  STRESS_TEST_REPORT_GET: 'stress-test-report:get',

  // Memo evidence (sidecar to investment_memo_versions)
  MEMO_EVIDENCE_LIST_BY_VERSION: 'memo-evidence:list-by-version',

  // Memo-generation pre-flight + cancel
  INVESTMENT_MEMO_PREFLIGHT: 'investment-memo:preflight',
  INVESTMENT_MEMO_GENERATE_ABORT: 'investment-memo:generate-abort',
  // Per-section refresh (Delight #5): regenerates a single section against
  // current data; bumps memo version with a `Refreshed section: X` note.
  INVESTMENT_MEMO_REGENERATE_SECTION: 'investment-memo:regenerate-section',

  // Chat context-size preflight (drives the banner above chat input)
  CHAT_CONTEXT_SIZE_PREFLIGHT: 'chat:context-size-preflight',

  // Broadcast: emitted from toggleFileFlag so any chat banner / Files tab
  // open in another window can refresh in real time.
  COMPANY_FLAGS_CHANGED: 'company:flags-changed',

  // Agent runs observability (/dev/agent-runs dashboard)
  AGENT_RUNS_LIST: 'agent-runs:list',
  AGENT_RUN_GET: 'agent-runs:get',
  AGENT_RUN_LIST_EVENTS: 'agent-runs:list-events',
  AGENT_RUNS_AVERAGE_COST: 'agent-runs:average-cost',

  // Speaker rename
  MEETING_RENAME_SPEAKERS: 'meeting:rename-speakers',

  // Title rename
  MEETING_RENAME_TITLE: 'meeting:rename-title',

  // Notes
  MEETING_SAVE_NOTES: 'meeting:save-notes',
  MEETING_SAVE_SUMMARY: 'meeting:save-summary',
  MEETING_PREPARE: 'meeting:prepare',
  MEETING_CREATE: 'meeting:create',

  // Templates
  TEMPLATE_LIST: 'template:list',
  TEMPLATE_GET: 'template:get',
  TEMPLATE_CREATE: 'template:create',
  TEMPLATE_UPDATE: 'template:update',
  TEMPLATE_DELETE: 'template:delete',

  // Summarization
  SUMMARY_GENERATE: 'summary:generate',
  SUMMARY_REGENERATE: 'summary:regenerate',
  SUMMARY_PROGRESS: 'summary:progress',
  SUMMARY_PHASE: 'summary:phase',
  SUMMARY_ABORT: 'summary:abort',

  // AI Chat
  MEETING_SAVE_CHAT: 'meeting:save-chat',
  CHAT_QUERY_MEETING: 'chat:query-meeting',
  CHAT_QUERY_SEARCH_RESULTS: 'chat:query-search-results',
  CHAT_QUERY_ALL: 'chat:query-all',
  CHAT_ABORT_ALL: 'chat:abort-all',
  CHAT_PROGRESS: 'chat:progress',
  CHAT_ABORT: 'chat:abort',
  CHAT_SAVE_AS_NOTE: 'chat:save-as-note',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_TEST_LLM_KEY: 'settings:test-llm-key',
  USER_GET_CURRENT: 'user:get-current',
  USER_UPDATE_CURRENT: 'user:update-current',

  // Drive
  DRIVE_GET_SHARE_LINK: 'drive:get-share-link',
  DRIVE_HAS_SCOPE: 'drive:has-scope',
  DRIVE_HAS_FILES_SCOPE: 'drive:has-files-scope',
  DRIVE_LIST_FOLDERS: 'drive:list-folders',
  DRIVE_AUTHORIZE_FILES: 'drive:authorize-files',

  // Web Share
  WEB_SHARE_CREATE: 'web-share:create',
  WEB_SHARE_CREATE_NOTE: 'web-share:create-note',

  // Video recording
  VIDEO_START: 'video:start',
  VIDEO_STOP: 'video:stop',
  VIDEO_CHUNK: 'video:chunk',
  VIDEO_GET_PATH: 'video:get-path',
  VIDEO_FIND_WINDOW: 'video:find-window',
  VIDEO_SET_WINDOW_SOURCE: 'video:set-window-source',
  VIDEO_CLEAR_WINDOW_SOURCE: 'video:clear-window-source',
  // Broadcast events fired by the main process when background finalization
  // (after VIDEO_STOP returns optimistically) completes or fails.
  VIDEO_FINALIZED: 'video:finalized',
  VIDEO_FINALIZE_ERROR: 'video:finalize-error',

  // Tasks
  TASK_LIST: 'task:list',
  TASK_GET: 'task:get',
  TASK_CREATE: 'task:create',
  TASK_UPDATE: 'task:update',
  TASK_DELETE: 'task:delete',
  TASK_LIST_FOR_MEETING: 'task:list-for-meeting',
  TASK_LIST_FOR_COMPANY: 'task:list-for-company',
  TASK_SUMMARY_STATS: 'task:summary-stats',
  TASK_BULK_UPDATE_STATUS: 'task:bulk-update-status',
  TASK_BULK_CREATE: 'task:bulk-create',

  // Custom Fields
  CUSTOM_FIELD_LIST_DEFINITIONS: 'custom-field:list-definitions',
  CUSTOM_FIELD_CREATE_DEFINITION: 'custom-field:create-definition',
  CUSTOM_FIELD_UPDATE_DEFINITION: 'custom-field:update-definition',
  CUSTOM_FIELD_DELETE_DEFINITION: 'custom-field:delete-definition',
  CUSTOM_FIELD_REORDER_DEFINITIONS: 'custom-field:reorder-definitions',
  CUSTOM_FIELD_GET_VALUES: 'custom-field:get-values',
  CUSTOM_FIELD_SET_VALUE: 'custom-field:set-value',
  CUSTOM_FIELD_DELETE_VALUE: 'custom-field:delete-value',
  CUSTOM_FIELD_COUNT_VALUES: 'custom-field:count-values',
  CUSTOM_FIELD_GET_BULK_VALUES: 'custom-field:get-bulk-values',
  CUSTOM_FIELD_RENAME_BUILTIN_OPTION: 'custom-field:rename-builtin-option',
  CUSTOM_FIELD_COUNT_BUILTIN_OPTION: 'custom-field:count-builtin-option',

  // CSV Import
  CSV_OPEN_FILE_DIALOG: 'csv:open-file-dialog',
  CSV_PARSE_FILE: 'csv:parse-file',
  CSV_SUGGEST_MAPPINGS: 'csv:suggest-mappings',
  CSV_PREVIEW: 'csv:preview',
  CSV_IMPORT: 'csv:import',
  CSV_IMPORT_PROGRESS: 'csv:import:progress',
  CSV_IMPORT_CANCEL: 'csv:import:cancel',

  // User preferences
  USER_PREF_GET_ALL: 'user-pref:get-all',
  USER_PREF_SET: 'user-pref:set',

  // Maintenance
  MEETING_NOTES_BACKFILL: 'maintenance:meeting-notes-backfill',

  // Contact enrichment
  CONTACT_ENRICH_FROM_MEETING: 'contact:enrich-from-meeting',

  // Company on-demand enrichment
  COMPANY_ENRICH_FROM_MEETINGS: 'company:enrich-from-meetings',
  COMPANY_ENRICH_FROM_NOTES: 'company:enrich-from-notes',
  COMPANY_ENRICH_FROM_EMAILS: 'company:enrich-from-emails',

  // Pitch deck ingestion (PDF or URL → LLM extraction → company profile)
  COMPANY_PITCH_DECK_OPEN_DIALOG: 'company:pitch-deck-open-dialog',
  COMPANY_PITCH_DECK_INGEST: 'company:pitch-deck-ingest',

  // File-based company enhancement — runs VC analysis + creates note, without touching partner sync
  COMPANY_ANALYZE_FILE: 'company:analyze-file',

  // Partner Meeting Digest
  PARTNER_MEETING_GET_ACTIVE: 'partner-meeting:get-active',
  PARTNER_MEETING_GET: 'partner-meeting:get',
  PARTNER_MEETING_LIST: 'partner-meeting:list',
  PARTNER_MEETING_CONCLUDE: 'partner-meeting:conclude',
  PARTNER_MEETING_EXPORT_PDF: 'partner-meeting:export-pdf',
  PARTNER_MEETING_ITEM_ADD: 'partner-meeting:item-add',
  PARTNER_MEETING_ITEM_UPDATE: 'partner-meeting:item-update',
  PARTNER_MEETING_ITEM_DELETE: 'partner-meeting:item-delete',
  PARTNER_MEETING_GET_SUGGESTIONS: 'partner-meeting:get-suggestions',
  PARTNER_MEETING_DISMISS_SUGGESTION: 'partner-meeting:dismiss-suggestion',
  PARTNER_MEETING_GENERATE_BRIEF: 'partner-meeting:generate-brief',
  PARTNER_MEETING_ADD_PITCH_DECK_COMPANY: 'partner-meeting:add-pitch-deck-company',
  PARTNER_MEETING_SET_MEETING: 'partner-meeting:set-meeting',
  PARTNER_MEETING_GENERATE_RECONCILIATION: 'partner-meeting:generate-reconciliation',
  PARTNER_MEETING_RECONCILE_PROPOSAL: 'partner-meeting:reconcile-proposal',
  PARTNER_MEETING_RECONCILE_CANCEL: 'partner-meeting:reconcile-cancel',
  PARTNER_MEETING_APPLY_RECONCILIATION: 'partner-meeting:apply-reconciliation',

  // App
  APP_CHECK_PERMISSIONS: 'app:check-permissions',
  APP_OPEN_STORAGE_DIR: 'app:open-storage-dir',
  APP_OPEN_EXTERNAL_URL: 'app:open-external-url',
  APP_GET_STORAGE_PATH: 'app:get-storage-path',
  APP_CHANGE_STORAGE_DIR: 'app:change-storage-dir',
  // Capability-scoped open: takes a flagged-file id (auto-flags when
  // companyId provided, same as FILE_READ_BY_FLAGGED_ID). Replaces the
  // old APP_OPEN_PATH(arbitrary-path) channel (removed in PR2).
  APP_OPEN_FLAGGED_FILE: 'app:open-flagged-file',
  // Open a directory path that's stored in a setting (the renderer passes
  // the SETTING NAME, not the path). Main reads the setting, verifies the
  // value is an existing directory, then opens it. Today only
  // 'companyLocalFilesRoot' is supported.
  APP_OPEN_USER_FOLDER: 'app:open-user-folder',
  APP_PICK_FOLDER: 'app:pick-folder',
  APP_PICK_LOGO_FILE: 'app:pick-logo-file',
  APP_OPEN_NOTE_WINDOW: 'app:open-note-window',

  // Cross-window broadcasts (main → renderer)
  NOTE_UPDATED: 'note:updated'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
