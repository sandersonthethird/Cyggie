export type LlmProvider = 'claude' | 'ollama'

export interface AppSettings {
  storagePath: string
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  ollamaHost: string
  ollamaModel: string
  calendarConnected: boolean
  autoRecord: boolean
  showLiveTranscript: boolean
  companyDriveRootFolder: string
  theme: 'system' | 'light' | 'dark'
}

export const DEFAULT_SETTINGS: AppSettings = {
  storagePath: '',
  deepgramApiKey: '',
  llmProvider: 'claude',
  claudeApiKey: '',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.1',
  calendarConnected: false,
  autoRecord: false,
  showLiveTranscript: true,
  companyDriveRootFolder: '',
  theme: 'system'
}
