export const IPC_CHANNELS = {
  // Meeting operations
  MEETING_LIST: 'meeting:list',
  MEETING_GET: 'meeting:get',
  MEETING_DELETE: 'meeting:delete',
  MEETING_UPDATE: 'meeting:update',

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
  COMPANY_TAG_FROM_MEETING: 'company:tag-from-meeting',
  COMPANY_MEETINGS: 'company:meetings',
  COMPANY_CONTACTS: 'company:contacts',
  COMPANY_EMAILS: 'company:emails',
  COMPANY_EMAIL_INGEST: 'company:email-ingest',
  COMPANY_FILES: 'company:files',
  COMPANY_TIMELINE: 'company:timeline',

  // Contacts
  CONTACT_LIST: 'contact:list',
  CONTACT_GET: 'contact:get',
  CONTACT_EMAILS: 'contact:emails',
  CONTACT_EMAIL_INGEST: 'contact:email-ingest',
  CONTACT_CREATE: 'contact:create',
  CONTACT_ADD_EMAIL: 'contact:add-email',
  CONTACT_SET_COMPANY: 'contact:set-company',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_SYNC_FROM_MEETINGS: 'contact:sync-from-meetings',
  CONTACT_RESOLVE_EMAILS: 'contact:resolve-emails',

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
  COMPANY_NOTES_CREATE: 'company-notes:create',
  COMPANY_NOTES_UPDATE: 'company-notes:update',
  COMPANY_NOTES_DELETE: 'company-notes:delete',

  // Company chat
  COMPANY_CHAT_LIST: 'company-chat:list',
  COMPANY_CHAT_CREATE: 'company-chat:create',
  COMPANY_CHAT_MESSAGES: 'company-chat:messages',
  COMPANY_CHAT_APPEND: 'company-chat:append',

  // Investment memo
  INVESTMENT_MEMO_GET_OR_CREATE: 'investment-memo:get-or-create',
  INVESTMENT_MEMO_LIST_VERSIONS: 'investment-memo:list-versions',
  INVESTMENT_MEMO_SAVE_VERSION: 'investment-memo:save-version',
  INVESTMENT_MEMO_SET_STATUS: 'investment-memo:set-status',
  INVESTMENT_MEMO_EXPORT_PDF: 'investment-memo:export-pdf',

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

  // App
  APP_CHECK_PERMISSIONS: 'app:check-permissions',
  APP_OPEN_STORAGE_DIR: 'app:open-storage-dir',
  APP_OPEN_EXTERNAL_URL: 'app:open-external-url',
  APP_GET_STORAGE_PATH: 'app:get-storage-path',
  APP_CHANGE_STORAGE_DIR: 'app:change-storage-dir',
  APP_OPEN_PATH: 'app:open-path',
  APP_PICK_FOLDER: 'app:pick-folder'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
