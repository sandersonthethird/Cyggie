// =============================================================================
// meeting-templates.ts — canonical default meeting-summary templates (T25).
//
// SINGLE SOURCE OF TRUTH. Before T25 these 5 templates were defined three
// times (desktop seed src/shared/constants/templates.ts, gateway array
// api-gateway/src/templates/meeting-summary-templates.ts, and the mobile
// picker fetched the gateway copy). They silently drifted. Now:
//   • desktop seed (src/shared/constants/templates.ts) maps these into
//     MeetingTemplateSeed (adds outputFormat + sortOrder).
//   • gateway (api-gateway/src/templates/meeting-summary-templates.ts)
//     re-exports these + the id helpers.
//   • mobile keeps fetching GET /templates (gateway copy → these).
//
// `category` ⟷ gateway `id` are the same value (vc_pitch, founder_checkin,
// partners, lp, general). The wire format (mobile picker IDs) is stable.
// =============================================================================

export type MeetingTemplateCategory =
  | 'vc_pitch'
  | 'founder_checkin'
  | 'partners'
  | 'lp'
  | 'general'

export interface CanonicalMeetingTemplate {
  /** Stable id — equals the desktop seed `category` and the gateway `id`. */
  category: MeetingTemplateCategory
  name: string
  description: string
  systemPrompt: string
  userPromptTemplate: string
}

export const CANONICAL_MEETING_TEMPLATES: readonly CanonicalMeetingTemplate[] = [
  {
    category: 'vc_pitch',
    name: 'VC Pitch Meeting',
    description:
      'Summarize a venture capital pitch meeting with focus on company metrics, ask, and investment thesis',
    systemPrompt: `You are an expert venture capital analyst. Summarize meeting transcripts with precision, focusing on the company's value proposition, market opportunity, traction metrics, team background, funding ask, and use of proceeds. Flag any red flags or areas needing follow-up due diligence. Keep summaries concise — use brief bullet points rather than full paragraphs, and aim for 500–800 words total. When mentioning dollar amounts, always use standard VC notation: $2M, $500K, $1.5B. Never write $2000M or combine a numeric multiplier with a unit suffix.`,
    userPromptTemplate: `Summarize the following VC pitch meeting transcript.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

Please provide a structured summary with these sections:
1. **Company Overview** - What the company does, stage, and sector
2. **Key Metrics & Traction** - Revenue, growth, users, retention
3. **Team** - Founders and key team backgrounds
4. **Market Opportunity** - TAM/SAM/SOM, competitive landscape
5. **The Ask** - Funding amount, valuation, use of proceeds
6. **Strengths** - What's compelling about this opportunity
7. **Concerns & Follow-ups** - Red flags, open questions, due diligence items
8. **Action Items** - Next steps discussed

Keep each section brief with concise bullet points. Omit any section that has no relevant content from the transcript.`,
  },
  {
    category: 'founder_checkin',
    name: 'Founder Check-in',
    description: 'Summarize a portfolio company check-in meeting',
    systemPrompt: `You are a venture capital portfolio manager. Summarize founder check-in meetings, focusing on operational progress, key challenges, burn rate, runway, hiring, and any support needs. Keep summaries concise — use brief bullet points rather than full paragraphs, and aim for 500–800 words total.`,
    userPromptTemplate: `Summarize the following founder check-in meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

Please provide:
1. **Progress Update** - Key milestones hit since last check-in
2. **Metrics Update** - Revenue, growth, burn, runway
3. **Challenges** - Current blockers or concerns
4. **Hiring & Team** - Team changes, open roles
5. **Support Needed** - Introductions, advice, resources requested
6. **Action Items** - Commitments made by both sides
7. **Overall Assessment** - Trajectory and health of the company

Keep each section brief with concise bullet points. Omit any section that has no relevant content from the transcript.`,
  },
  {
    category: 'partners',
    name: 'Partners Meeting',
    description: 'Summarize an internal partners meeting',
    systemPrompt: `You are a venture capital firm's chief of staff. Summarize internal partner meetings with focus on decisions made, dissenting opinions, action items, and deadlines. Keep summaries concise — use brief bullet points rather than full paragraphs, and aim for 500–800 words total.`,
    userPromptTemplate: `Summarize the following partners meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

Please provide:
1. **Decisions Made** - Key decisions and rationale
2. **Dissenting Views** - Notable disagreements or alternative perspectives
3. **Deal Discussion** - Companies/deals discussed and outcomes
4. **Fund Updates** - Portfolio, fundraising, or operational updates
5. **Action Items** - Tasks assigned with responsible partner and deadline

Keep each section brief with concise bullet points. Omit any section that has no relevant content from the transcript.`,
  },
  {
    category: 'lp',
    name: 'LP Meeting',
    description: 'Summarize a limited partner meeting or call',
    systemPrompt: `You are a venture capital investor relations professional. Summarize LP meetings with focus on questions raised, concerns, commitments, and follow-up materials needed. Keep summaries concise — use brief bullet points rather than full paragraphs, and aim for 500–800 words total.`,
    userPromptTemplate: `Summarize the following LP meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

Please provide:
1. **Questions Asked** - Key questions from LPs
2. **Concerns Raised** - Areas of concern or pushback
3. **Fund Performance Discussion** - Performance metrics discussed
4. **Commitments Made** - Any commitments by either party
5. **Follow-up Materials** - Documents or data requested
6. **Action Items** - Next steps and timeline

Keep each section brief with concise bullet points. Omit any section that has no relevant content from the transcript.`,
  },
  {
    category: 'general',
    name: 'General Meeting',
    description: 'General-purpose meeting summary',
    systemPrompt: `You are a professional meeting summarizer. Create clear, actionable summaries that capture the key points, decisions, and follow-up items from meetings. Keep summaries concise — use brief bullet points rather than full paragraphs, and aim for 500–800 words total.`,
    userPromptTemplate: `Summarize the following meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

Please provide:
1. **Attendees** - Who was present
2. **Agenda Items** - Topics discussed
3. **Key Points** - Important information shared
4. **Decisions** - Decisions made during the meeting
5. **Action Items** - Tasks with owners and deadlines

Keep each section brief with concise bullet points. Omit any section that has no relevant content from the transcript.`,
  },
]

export const MEETING_TEMPLATE_IDS = CANONICAL_MEETING_TEMPLATES.map(
  (t) => t.category,
) as readonly MeetingTemplateCategory[]

export function findCanonicalMeetingTemplate(
  id: string,
): CanonicalMeetingTemplate | undefined {
  return CANONICAL_MEETING_TEMPLATES.find((t) => t.category === id)
}
