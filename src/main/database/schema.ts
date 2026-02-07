// Raw database row types (snake_case matching SQLite columns)

export interface MeetingRow {
  id: string
  title: string
  date: string
  duration_seconds: number | null
  calendar_event_id: string | null
  meeting_platform: string | null
  meeting_url: string | null
  transcript_path: string | null
  summary_path: string | null
  notes: string | null
  transcript_segments: string | null
  transcript_drive_id: string | null
  summary_drive_id: string | null
  template_id: string | null
  speaker_count: number
  speaker_map: string
  attendees: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface TemplateRow {
  id: string
  name: string
  description: string | null
  category: string
  system_prompt: string
  user_prompt_template: string
  output_format: string
  is_default: number
  is_active: number
  sort_order: number
  created_at: string
  updated_at: string
}

export interface SettingsRow {
  key: string
  value: string
  updated_at: string
}

export interface FtsRow {
  meeting_id: string
  title: string
  transcript_text: string
  summary_text: string
}
