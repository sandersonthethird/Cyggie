export type LlmProvider = 'claude' | 'ollama' | 'openai'

/**
 * Renderer-facing shape for encrypted API keys.
 *
 * The renderer never receives plaintext key material. SETTINGS_GET /
 * SETTINGS_GET_ALL return `{ configured, masked }` where `masked` is the
 * last-4-character preview (e.g. `'••••a4f2'`) and `configured` reflects
 * whether a real key is currently stored. To use the key (e.g. test it),
 * the renderer calls SETTINGS_TEST_LLM_KEY — main decrypts internally.
 *
 * Writes (SETTINGS_SET) still take plaintext over IPC; main encrypts before
 * the value reaches the DB.
 *
 * If the OS keychain is unavailable (`safeStorage.isEncryptionAvailable()`
 * returns false), masked-key reads return `{ configured: false, masked: '' }`
 * — see settings.ipc.ts for the rationale. The Settings UI surfaces this via
 * a banner so the bad state is loud, not silent.
 */
export interface MaskedKey {
  configured: boolean
  masked: string
}

/** Keys whose plaintext never crosses the IPC boundary. */
export const ENCRYPTED_KEYS = [
  'deepgramApiKey',
  'claudeApiKey',
  'openAiApiKey',
  'exaApiKey',
  'webShareApiKey',
] as const
export type EncryptedKey = (typeof ENCRYPTED_KEYS)[number]

export interface AppSettings {
  storagePath: string
  deepgramApiKey: MaskedKey
  llmProvider: LlmProvider
  claudeApiKey: MaskedKey
  claudeSummaryModel: string
  claudeEnrichmentModel: string
  claudeChatModel: string
  ollamaHost: string
  ollamaModel: string
  openAiApiKey: MaskedKey
  openAiSummaryModel: string
  openAiEnrichmentModel: string
  openAiChatModel: string
  calendarConnected: boolean
  autoRecord: boolean
  showLiveTranscript: boolean
  companyDriveRootFolder: string
  companyLocalFilesRoot: string
  theme: 'system' | 'light' | 'dark'
  brandingLogoDataUrl: string
  autoSyncEmails: boolean
  webShareModel: string
  webShareApiKey: MaskedKey
  exaApiKey: MaskedKey
}

export const UNCONFIGURED_KEY: MaskedKey = { configured: false, masked: '' }

export const DEFAULT_SETTINGS: AppSettings = {
  storagePath: '',
  deepgramApiKey: UNCONFIGURED_KEY,
  llmProvider: 'claude',
  claudeApiKey: UNCONFIGURED_KEY,
  claudeSummaryModel: 'claude-sonnet-4-5-20250929',
  claudeEnrichmentModel: 'claude-haiku-4-5-20251001',
  claudeChatModel: 'claude-sonnet-4-5-20250929',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.1',
  openAiApiKey: UNCONFIGURED_KEY,
  openAiSummaryModel: 'gpt-4o',
  openAiEnrichmentModel: 'gpt-4o-mini',
  openAiChatModel: 'gpt-4o',
  webShareModel: 'claude-sonnet-4-5-20250929',
  webShareApiKey: UNCONFIGURED_KEY,
  calendarConnected: false,
  autoRecord: false,
  showLiveTranscript: true,
  companyDriveRootFolder: '',
  companyLocalFilesRoot: '',
  theme: 'system',
  brandingLogoDataUrl: '',
  autoSyncEmails: true,
  exaApiKey: UNCONFIGURED_KEY,
}
