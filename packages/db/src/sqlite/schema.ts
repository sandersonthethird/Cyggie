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
  // AI-generated summary markdown — populated by the desktop summarizer alongside
  // summary_path so mobile can read it via GET /meetings/:id. Migration 099.
  summary: string | null
  notes: string | null
  transcript_segments: string | null
  transcript_drive_id: string | null
  summary_drive_id: string | null
  template_id: string | null
  speaker_count: number
  speaker_map: string
  attendees: string | null
  attendee_emails: string | null
  // Owner's calendar-side display name (migration 107). Populated from
  // CalendarEvent.selfName at meeting creation; used by the LLM summarizer
  // to render "Attendees: <selfName> (meeting owner), <others>" without
  // having to look up the requesting user (which would conflate self with
  // user.sub — wrong once firm-shared meetings ship).
  self_name: string | null
  transcript_provider: string | null
  me_speaker_index: number | null
  companies: string | null
  dismissed_companies: string | null
  chat_messages: string | null
  recording_path: string | null
  status: string
  // Group-event ingestion gate (migration 098). 0/1 booleans.
  // is_group_event: true → syncContactsFromAttendees + company link auto-creation skipped.
  // is_group_event_user_set: true → calendar re-sync must NOT recompute the flag.
  is_group_event: number
  is_group_event_user_set: number
  created_at: string
  updated_at: string
  // Populated by LEFT JOIN in listMeetings — null when no company linked
  company_id?: string | null
  company_name?: string | null
  company_domain?: string | null
  company_stage?: string | null
  company_entity_type?: string | null
}

export interface TemplateRow {
  id: string
  name: string
  description: string | null
  category: string
  system_prompt: string
  user_prompt_template: string
  instructions: string | null
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

export interface TaskRow {
  id: string
  title: string
  description: string | null
  meeting_id: string | null
  company_id: string | null
  contact_id: string | null
  status: string
  category: string
  priority: string | null
  assignee: string | null
  due_date: string | null
  source: string
  source_section: string | null
  extraction_hash: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
}
