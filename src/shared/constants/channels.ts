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

  // Search
  SEARCH_QUERY: 'search:query',
  SEARCH_ADVANCED: 'search:advanced',
  SEARCH_ALL_SPEAKERS: 'search:all-speakers',
  SEARCH_SUGGEST: 'search:suggest',
  SEARCH_CATEGORIZED: 'search:categorized',

  // Company enrichment
  COMPANY_ENRICH_MEETING: 'company:enrich-meeting',
  COMPANY_GET_SUGGESTIONS: 'company:get-suggestions',

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

  // AI Chat
  MEETING_SAVE_CHAT: 'meeting:save-chat',
  CHAT_QUERY_MEETING: 'chat:query-meeting',
  CHAT_QUERY_GLOBAL: 'chat:query-global',
  CHAT_QUERY_SEARCH_RESULTS: 'chat:query-search-results',
  CHAT_PROGRESS: 'chat:progress',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',

  // Drive
  DRIVE_GET_SHARE_LINK: 'drive:get-share-link',
  DRIVE_HAS_SCOPE: 'drive:has-scope',

  // Web Share
  WEB_SHARE_CREATE: 'web-share:create',

  // App
  APP_CHECK_PERMISSIONS: 'app:check-permissions',
  APP_OPEN_STORAGE_DIR: 'app:open-storage-dir',
  APP_GET_STORAGE_PATH: 'app:get-storage-path',
  APP_CHANGE_STORAGE_DIR: 'app:change-storage-dir'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
