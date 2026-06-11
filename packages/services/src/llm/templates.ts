import type { MeetingTemplate } from '@shared/types/template'

export interface PromptContext {
  transcript: string
  meetingTitle: string
  date: string
  duration: string
  speakers: string[]
  notes?: string
  companies?: string[]
  /**
   * Calendar non-self attendees (from meeting.attendees). Distinguishes:
   *   • null      → no calendar event linked; fall back to `speakers`
   *   • []        → calendar event existed with no other attendees;
   *                 render just the owner + assert calendar authority
   *   • [name…]   → render owner + names + assert calendar authority
   */
  attendees?: string[] | null
  /**
   * Owner's calendar-side display name (meeting.self_name). Prepended to
   * the attendees list with a "(meeting owner)" suffix. Comes from the
   * meeting row, NOT from the requesting user — see migration 0022 SQL
   * for the rationale (firm-shared meetings guard).
   */
  selfName?: string | null
  userIdentity?: {
    displayName: string
    email: string | null
    title: string | null
    jobFunction: string | null
  }
}

const INSTRUCTIONS_WRAPPER = `Meeting: {{meeting_title}}
Date: {{date}} | Duration: {{duration}}
Attendees: {{attendees}}

---

Transcript:
{{transcript}}

---

{{instructions}}`

const DEFAULT_INSTRUCTIONS_SYSTEM_PROMPT =
  'You are an expert meeting analyst. Provide clear, structured meeting summaries in markdown format.'

/**
 * Trailer text appended to the prompt when the meeting has a known
 * calendar attendee list. Tells the model not to hallucinate attendees
 * from transcript mentions.
 *
 * MUST stay identical to AUTHORITATIVE_ATTENDEES_INSTRUCTION in
 * api-gateway/src/templates/meeting-summary-templates.ts. T25 fixes the
 * duplication.
 */
export const AUTHORITATIVE_ATTENDEES_INSTRUCTION =
  `Attendees source: The "Attendees" list above comes from the calendar invite for ` +
  `this meeting and is the authoritative list of who attended. Do NOT list anyone ` +
  `as an attendee, participant, or person on the call in your summary unless they ` +
  `appear in that list. People mentioned in the transcript who were not on the ` +
  `call should be referenced as "mentioned" or "discussed" — never as attendees.`

/**
 * Grounding trailer appended to every prompt. Keeps the model from inventing
 * content the participants never said — the most common failure is fabricating
 * a company "vision", market sizing, or strengths that go beyond the transcript.
 */
export const ANTI_FABRICATION_INSTRUCTION =
  `Stay grounded in the transcript: Base every statement strictly on what ` +
  `participants actually said. Do not infer, speculate, or invent. Do NOT describe ` +
  `the company's vision, market size (TAM/SAM/SOM), competitive positioning, or ` +
  `strengths unless a participant explicitly stated them. If a section has no ` +
  `supporting content in the transcript, omit that section entirely rather than ` +
  `filling it in.`

/**
 * Trailer appended when the meeting is linked to a known company in the CRM.
 * The "Company" line in Meeting Context carries the canonical name; this tells
 * the model to use it verbatim instead of inventing a variant from the
 * transcript or an email domain (e.g. "Shepherd AI" → "yourShepherd.ai").
 */
export const AUTHORITATIVE_COMPANY_INSTRUCTION =
  `Company name source: The "Company" listed in Meeting Context is the ` +
  `authoritative name from the CRM. Use it EXACTLY as written when referring to ` +
  `the company. Do NOT rename it, reformat it, or infer an alternate spelling, ` +
  `domain, or product name from the transcript or email addresses.`

/**
 * Builds the `{{attendees}}` value for the prompt header and returns a
 * flag indicating whether the value reflects calendar truth (in which
 * case the caller should append the authoritative-source instruction).
 *
 * Branches:
 *   • attendees null/undefined → speakers-fallback (transcript-derived);
 *     no calendar truth claim.
 *   • attendees === [] + selfName → "<selfName> (meeting owner)" alone;
 *     calendar truth (solo invite is a real signal).
 *   • attendees === [] + !selfName → "(no attendees recorded)" alone;
 *     calendar truth (defensive — rare).
 *   • attendees has items → "<selfName> (meeting owner), name1, name2";
 *     selfName omitted if null (firm-shared-meetings guard — requesting
 *     user may not be a calendar attendee).
 */
function buildAttendeesValue(context: PromptContext): {
  rendered: string
  hasCalendarTruth: boolean
} {
  const speakersFallback = context.speakers.join(', ')
  const attendees = context.attendees
  if (attendees == null) {
    return { rendered: speakersFallback, hasCalendarTruth: false }
  }
  const ownerLabel = context.selfName?.trim()
    ? `${context.selfName.trim()} (meeting owner)`
    : null
  const cleaned = attendees.map((a) => a?.trim()).filter((a): a is string => !!a)
  if (cleaned.length === 0) {
    return {
      rendered: ownerLabel ?? '(no attendees recorded)',
      hasCalendarTruth: true,
    }
  }
  const parts = ownerLabel ? [ownerLabel, ...cleaned] : cleaned
  return { rendered: parts.join(', '), hasCalendarTruth: true }
}

export function buildPrompt(
  template: MeetingTemplate,
  context: PromptContext
): { systemPrompt: string; userPrompt: string } {
  const usingInstructions = Boolean(template.instructions)
  let userPrompt = usingInstructions
    ? INSTRUCTIONS_WRAPPER.replace('{{instructions}}', template.instructions!)
    : template.userPromptTemplate

  const companiesStr = context.companies?.filter(Boolean).join(', ') || ''
  const { rendered: attendeesStr, hasCalendarTruth } = buildAttendeesValue(context)

  const variables: Record<string, string> = {
    transcript: context.transcript,
    meeting_title: context.meetingTitle,
    date: context.date,
    duration: context.duration,
    // {{speakers}} retained for any legacy / custom template that still
    // references it. The default 5 use {{attendees}} (calendar truth)
    // after migration 106. See buildAttendeesValue above for branching.
    speakers: context.speakers.join(', '),
    notes: context.notes || '',
    companies: companiesStr,
    attendees: attendeesStr
  }

  // If the user has notes but the template doesn't use {{notes}},
  // append them to the transcript so the LLM can reference them
  const promptForNotesCheck = usingInstructions ? template.instructions! : template.userPromptTemplate
  if (context.notes && !promptForNotesCheck.includes('{{notes}}')) {
    variables.transcript = `${context.transcript}\n\n---\nUser Notes:\n${context.notes}`
  }

  // Build user identity string (retained for the task-attribution
  // trailer — owner-label in the {{attendees}} header now comes from
  // selfName, not userIdentity).
  const userIdentityParts: string[] = []
  if (context.userIdentity) {
    userIdentityParts.push(`Name: ${context.userIdentity.displayName}`)
    if (context.userIdentity.email) userIdentityParts.push(`Email: ${context.userIdentity.email}`)
    if (context.userIdentity.title) userIdentityParts.push(`Title: ${context.userIdentity.title}`)
    if (context.userIdentity.jobFunction) userIdentityParts.push(`Function: ${context.userIdentity.jobFunction}`)
  }
  const userIdentityStr = userIdentityParts.join(', ')
  variables.user_identity = userIdentityStr

  // Append meeting context. Note: we no longer push an "Attendees:" line
  // here — calendar-truth attendees are now rendered in the prompt
  // header via {{attendees}}. The authoritative-source instruction goes
  // in this trailer when applicable.
  const contextParts: string[] = []
  if (companiesStr && (usingInstructions || !template.userPromptTemplate.includes('{{companies}}'))) {
    contextParts.push(`Company: ${companiesStr}`)
  }
  // When the meeting is linked to a known CRM company, instruct the model to use
  // that canonical name verbatim (gated on companiesStr, not the placeholder
  // branch above, so it fires for both default and custom templates).
  if (companiesStr) {
    contextParts.push(AUTHORITATIVE_COMPANY_INSTRUCTION)
  }
  if (userIdentityStr && (usingInstructions || !template.userPromptTemplate.includes('{{user_identity}}'))) {
    contextParts.push(`Meeting Owner (you): ${userIdentityStr}`)
  }
  if (hasCalendarTruth) {
    contextParts.push(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
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
  // Anti-fabrication grounding fires for every prompt (all default templates and
  // any user-authored custom template), so summaries never invent vision/market
  // content beyond what the transcript supports.
  contextParts.push(ANTI_FABRICATION_INSTRUCTION)
  if (contextParts.length > 0) {
    variables.transcript = `${variables.transcript}\n\n---\nMeeting Context:\n${contextParts.join('\n')}`
  }

  for (const [key, value] of Object.entries(variables)) {
    userPrompt = userPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }

  const systemPrompt = usingInstructions
    ? (template.systemPrompt || DEFAULT_INSTRUCTIONS_SYSTEM_PROMPT)
    : template.systemPrompt

  return {
    systemPrompt,
    userPrompt
  }
}
