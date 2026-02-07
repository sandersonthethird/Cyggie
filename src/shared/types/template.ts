export type TemplateCategory =
  | 'vc_pitch'
  | 'founder_checkin'
  | 'partners'
  | 'lp'
  | 'general'
  | 'custom'

export type OutputFormat = 'markdown' | 'bullet_points' | 'structured'

export interface MeetingTemplate {
  id: string
  name: string
  description: string
  category: TemplateCategory
  systemPrompt: string
  userPromptTemplate: string
  outputFormat: OutputFormat
  isDefault: boolean
  isActive: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface MeetingTemplateSeed {
  name: string
  description: string
  category: TemplateCategory
  systemPrompt: string
  userPromptTemplate: string
  outputFormat: OutputFormat
  sortOrder: number
}
