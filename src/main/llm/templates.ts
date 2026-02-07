import type { MeetingTemplate } from '../../shared/types/template'

export interface PromptContext {
  transcript: string
  meetingTitle: string
  date: string
  duration: string
  speakers: string[]
  notes?: string
}

export function buildPrompt(
  template: MeetingTemplate,
  context: PromptContext
): { systemPrompt: string; userPrompt: string } {
  let userPrompt = template.userPromptTemplate

  const variables: Record<string, string> = {
    transcript: context.transcript,
    meeting_title: context.meetingTitle,
    date: context.date,
    duration: context.duration,
    speakers: context.speakers.join(', '),
    notes: context.notes || ''
  }

  // If the user has notes but the template doesn't use {{notes}},
  // append them to the transcript so the LLM can reference them
  if (context.notes && !template.userPromptTemplate.includes('{{notes}}')) {
    variables.transcript = `${context.transcript}\n\n---\nUser Notes:\n${context.notes}`
  }

  for (const [key, value] of Object.entries(variables)) {
    userPrompt = userPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }

  return {
    systemPrompt: template.systemPrompt,
    userPrompt
  }
}
