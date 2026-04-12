export type LlmProvider = 'claude' | 'ollama' | 'openai'

export interface AppSettings {
  storagePath: string
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  claudeSummaryModel: string
  claudeEnrichmentModel: string
  ollamaHost: string
  ollamaModel: string
  openAiApiKey: string
  openAiSummaryModel: string
  openAiEnrichmentModel: string
  calendarConnected: boolean
  autoRecord: boolean
  showLiveTranscript: boolean
  companyDriveRootFolder: string
  companyLocalFilesRoot: string
  theme: 'system' | 'light' | 'dark'
  brandingLogoDataUrl: string
  autoSyncEmails: boolean
  exaApiKey: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  storagePath: '',
  deepgramApiKey: '',
  llmProvider: 'claude',
  claudeApiKey: '',
  claudeSummaryModel: 'claude-sonnet-4-5-20250929',
  claudeEnrichmentModel: 'claude-haiku-4-5-20251001',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.1',
  openAiApiKey: '',
  openAiSummaryModel: 'gpt-4o',
  openAiEnrichmentModel: 'gpt-4o-mini',
  calendarConnected: false,
  autoRecord: false,
  showLiveTranscript: true,
  companyDriveRootFolder: '',
  companyLocalFilesRoot: '',
  theme: 'system',
  brandingLogoDataUrl: '',
  autoSyncEmails: true,
  exaApiKey: ''
}
