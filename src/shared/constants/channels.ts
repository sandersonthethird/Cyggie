export const IPC_CHANNELS = {
  // Meeting operations
  MEETING_LIST: 'meeting:list',
  MEETING_GET: 'meeting:get',
  MEETING_DELETE: 'meeting:delete',
  MEETING_UPDATE: 'meeting:update',
  MEETING_TAG_SPEAKER_CONTACT: 'meeting:tag-speaker-contact',
  MEETING_LINK_EXISTING_COMPANY: 'meeting:link-existing-company',
  MEETING_UNLINK_COMPANY: 'meeting:unlink-company',

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

  // Calendar
  CALENDAR_CONNECT: 'calendar:connect',
  CALENDAR_DISCONNECT: 'calendar:disconnect',
  CALENDAR_EVENTS: 'calendar:events',
  CALENDAR_EVENTS_RANGE: 'calendar:events-range',
  CALENDAR_SYNC: 'calendar:sync',
  CALENDAR_IS_CONNECTED: 'calendar:is-connected',
  CALENDAR_REAUTHORIZE: 'calendar:reauthorize',

  // Gmail
  GMAIL_CONNECT: 'gmail:connect',
  GMAIL_DISCONNECT: 'gmail:disconnect',
  GMAIL_IS_CONNECTED: 'gmail:is-connected',

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
  COMPANY_GET: 'company:get',
  COMPANY_CREATE: 'company:create',
  COMPANY_UPDATE: 'company:update',
  COMPANY_MERGE: 'company:merge',
  COMPANY_DEDUP_SUSPECTED: 'company:dedup-suspected',
  COMPANY_DEDUP_APPLY: 'company:dedup-apply',
  COMPANY_DELETE: 'company:delete',
  COMPANY_TAG_FROM_MEETING: 'company:tag-from-meeting',
  COMPANY_MEETINGS: 'company:meetings',
  COMPANY_CONTACTS: 'company:contacts',
  COMPANY_EMAILS: 'company:emails',
  COMPANY_EMAIL_INGEST: 'company:email-ingest',
  COMPANY_EMAIL_INGEST_PROGRESS: 'company:email-ingest:progress',
  COMPANY_EMAIL_INGEST_CANCEL: 'company:email-ingest:cancel',
  COMPANY_FILES: 'company:files',
  COMPANY_FILES_READABLE: 'company:files-readable',
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
  CONTACT_SET_COMPANY: 'contact:set-company',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_DELETE: 'contact:delete',
  CONTACT_SYNC_FROM_MEETINGS: 'contact:sync-from-meetings',
  CONTACT_ENRICH_EXISTING: 'contact:enrich-existing',
  CONTACT_ENRICH_ONE: 'contact:enrich-one',
  CONTACT_ONBOARD_FROM_EMAIL: 'contact:onboard-from-email',
  CONTACT_ONBOARD_PROGRESS: 'contact:onboard-progress',
  CONTACT_RESOLVE_EMAILS: 'contact:resolve-emails',
  CONTACT_DEDUP_SUSPECTED: 'contact:dedup-suspected',
  CONTACT_DEDUP_APPLY: 'contact:dedup-apply',
  CONTACT_TIMELINE: 'contact:timeline',

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
  COMPANY_CHAT_LIST: 'company-chat:list',
  COMPANY_CHAT_CREATE: 'company-chat:create',
  COMPANY_CHAT_MESSAGES: 'company-chat:messages',
  COMPANY_CHAT_APPEND: 'company-chat:append',
  COMPANY_CHAT_QUERY: 'company:chat-query',
  COMPANY_CHAT_ABORT: 'company-chat:abort',

  // Contact chat
  CONTACT_CHAT_QUERY: 'contact-chat:query',
  CONTACT_CHAT_ABORT: 'contact-chat:abort',

  // Company file flags (for chat context)
  COMPANY_FILE_FLAG_GET: 'company:file-flag-get',
  COMPANY_FILE_FLAG_TOGGLE: 'company:file-flag-toggle',

  // Investment memo
  INVESTMENT_MEMO_GET_OR_CREATE: 'investment-memo:get-or-create',
  INVESTMENT_MEMO_LIST_VERSIONS: 'investment-memo:list-versions',
  INVESTMENT_MEMO_SAVE_VERSION: 'investment-memo:save-version',
  INVESTMENT_MEMO_SET_STATUS: 'investment-memo:set-status',
  INVESTMENT_MEMO_EXPORT_PDF: 'investment-memo:export-pdf',
  INVESTMENT_MEMO_EXPORT_GOOGLE_DOC: 'investment-memo:export-google-doc',
  INVESTMENT_MEMO_GENERATE: 'investment-memo:generate',
  INVESTMENT_MEMO_GENERATE_PROGRESS: 'investment-memo:generate-progress',

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
  CHAT_QUERY_GLOBAL: 'chat:query-global',
  CHAT_QUERY_SEARCH_RESULTS: 'chat:query-search-results',
  CHAT_PROGRESS: 'chat:progress',
  CHAT_ABORT: 'chat:abort',

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

  // Video recording
  VIDEO_START: 'video:start',
  VIDEO_STOP: 'video:stop',
  VIDEO_CHUNK: 'video:chunk',
  VIDEO_GET_PATH: 'video:get-path',
  VIDEO_FIND_WINDOW: 'video:find-window',
  VIDEO_SET_WINDOW_SOURCE: 'video:set-window-source',
  VIDEO_CLEAR_WINDOW_SOURCE: 'video:clear-window-source',

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

  // Company on-demand enrichment (batched — one LLM call for all meetings)
  COMPANY_ENRICH_FROM_MEETINGS: 'company:enrich-from-meetings',

  // App
  APP_CHECK_PERMISSIONS: 'app:check-permissions',
  APP_OPEN_STORAGE_DIR: 'app:open-storage-dir',
  APP_OPEN_EXTERNAL_URL: 'app:open-external-url',
  APP_GET_STORAGE_PATH: 'app:get-storage-path',
  APP_CHANGE_STORAGE_DIR: 'app:change-storage-dir',
  APP_OPEN_PATH: 'app:open-path',
  APP_PICK_FOLDER: 'app:pick-folder',
  APP_PICK_LOGO_FILE: 'app:pick-logo-file'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
