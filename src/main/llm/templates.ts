import type { MeetingTemplate } from '../../shared/types/template'

export interface PromptContext {
  transcript: string
  meetingTitle: string
  date: string
  duration: string
  speakers: string[]
  notes?: string
  companies?: string[]
  attendees?: string[]
  userIdentity?: {
    displayName: string
    email: string | null
    title: string | null
    jobFunction: string | null
  }
}

export function buildPrompt(
  template: MeetingTemplate,
  context: PromptContext
): { systemPrompt: string; userPrompt: string } {
  let userPrompt = template.userPromptTemplate

  const companiesStr = context.companies?.filter(Boolean).join(', ') || ''
  const attendeesStr = context.attendees?.filter(Boolean).join(', ') || ''

  const variables: Record<string, string> = {
    transcript: context.transcript,
    meeting_title: context.meetingTitle,
    date: context.date,
    duration: context.duration,
    speakers: context.speakers.join(', '),
    notes: context.notes || '',
    companies: companiesStr,
    attendees: attendeesStr
  }

  // If the user has notes but the template doesn't use {{notes}},
  // append them to the transcript so the LLM can reference them
  if (context.notes && !template.userPromptTemplate.includes('{{notes}}')) {
    variables.transcript = `${context.transcript}\n\n---\nUser Notes:\n${context.notes}`
  }

  // Build user identity string
  const userIdentityParts: string[] = []
  if (context.userIdentity) {
    userIdentityParts.push(`Name: ${context.userIdentity.displayName}`)
    if (context.userIdentity.email) userIdentityParts.push(`Email: ${context.userIdentity.email}`)
    if (context.userIdentity.title) userIdentityParts.push(`Title: ${context.userIdentity.title}`)
    if (context.userIdentity.jobFunction) userIdentityParts.push(`Function: ${context.userIdentity.jobFunction}`)
  }
  const userIdentityStr = userIdentityParts.join(', ')
  variables.user_identity = userIdentityStr

  // Append meeting context (companies, attendees, user identity) when the template
  // doesn't explicitly use those placeholders
  const contextParts: string[] = []
  if (companiesStr && !template.userPromptTemplate.includes('{{companies}}')) {
    contextParts.push(`Company: ${companiesStr}`)
  }
  if (attendeesStr && !template.userPromptTemplate.includes('{{attendees}}')) {
    contextParts.push(`Attendees: ${attendeesStr}`)
  }
  if (userIdentityStr && !template.userPromptTemplate.includes('{{user_identity}}')) {
    contextParts.push(`Meeting Owner (you): ${userIdentityStr}`)
  }
  if (context.userIdentity) {
    const ownerName = context.userIdentity.displayName
    contextParts.push(
      `\nTask Attribution Instructions:\n` +
      `In any "Action Items", "Next Steps", or "Follow-ups" section, only include items ` +
      `that are specifically attributable to ${ownerName} (the meeting owner). ` +
      `Do NOT include action items assigned to other participants. ` +
      `If ${ownerName} needs to conduct due diligence on multiple aspects of the company ` +
      `(e.g. verify claims, check references, review materials), consolidate them into a single ` +
      `"Due Diligence" action item and list the specific items as sub-points in the description ` +
      `rather than as separate top-level bullets.\n` +
      `IMPORTANT: Limit the total number of action items, next steps, and follow-ups to at most ` +
      `3 items (up to 5 if this is an internal meeting where all participants are from the same ` +
      `organization). Only include clear, important deliverables — not routine or trivial items. ` +
      `Consolidate related items into a single action item where possible.`
    )
  }
  if (contextParts.length > 0) {
    variables.transcript = `${variables.transcript}\n\n---\nMeeting Context:\n${contextParts.join('\n')}`
  }

  for (const [key, value] of Object.entries(variables)) {
    userPrompt = userPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }

  return {
    systemPrompt: template.systemPrompt,
    userPrompt
  }
}
