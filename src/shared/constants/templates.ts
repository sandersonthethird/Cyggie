import type { TemplateCategory, MeetingTemplateSeed } from '../types/template'

export const DEFAULT_TEMPLATES: MeetingTemplateSeed[] = [
  {
    name: 'VC Pitch Meeting',
    description:
      'Summarize a venture capital pitch meeting with focus on company metrics, ask, and investment thesis',
    category: 'vc_pitch',
    systemPrompt: `You are an expert venture capital analyst. Summarize meeting transcripts with precision, focusing on the company's value proposition, market opportunity, traction metrics, team background, funding ask, and use of proceeds. Flag any red flags or areas needing follow-up due diligence.`,
    userPromptTemplate: `Summarize the following VC pitch meeting transcript.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Participants: {{speakers}}

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
8. **Action Items** - Next steps discussed`,
    outputFormat: 'markdown',
    sortOrder: 0
  },
  {
    name: 'Founder Check-in',
    description: 'Summarize a portfolio company check-in meeting',
    category: 'founder_checkin',
    systemPrompt: `You are a venture capital portfolio manager. Summarize founder check-in meetings, focusing on operational progress, key challenges, burn rate, runway, hiring, and any support needs.`,
    userPromptTemplate: `Summarize the following founder check-in meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Participants: {{speakers}}

## Transcript:
{{transcript}}

Please provide:
1. **Progress Update** - Key milestones hit since last check-in
2. **Metrics Update** - Revenue, growth, burn, runway
3. **Challenges** - Current blockers or concerns
4. **Hiring & Team** - Team changes, open roles
5. **Support Needed** - Introductions, advice, resources requested
6. **Action Items** - Commitments made by both sides
7. **Overall Assessment** - Trajectory and health of the company`,
    outputFormat: 'markdown',
    sortOrder: 1
  },
  {
    name: 'Partners Meeting',
    description: 'Summarize an internal partners meeting',
    category: 'partners',
    systemPrompt: `You are a venture capital firm's chief of staff. Summarize internal partner meetings with focus on decisions made, dissenting opinions, action items, and deadlines.`,
    userPromptTemplate: `Summarize the following partners meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Participants: {{speakers}}

## Transcript:
{{transcript}}

Please provide:
1. **Decisions Made** - Key decisions and rationale
2. **Dissenting Views** - Notable disagreements or alternative perspectives
3. **Deal Discussion** - Companies/deals discussed and outcomes
4. **Fund Updates** - Portfolio, fundraising, or operational updates
5. **Action Items** - Tasks assigned with responsible partner and deadline`,
    outputFormat: 'markdown',
    sortOrder: 2
  },
  {
    name: 'LP Meeting',
    description: 'Summarize a limited partner meeting or call',
    category: 'lp',
    systemPrompt: `You are a venture capital investor relations professional. Summarize LP meetings with focus on questions raised, concerns, commitments, and follow-up materials needed.`,
    userPromptTemplate: `Summarize the following LP meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Participants: {{speakers}}

## Transcript:
{{transcript}}

Please provide:
1. **Questions Asked** - Key questions from LPs
2. **Concerns Raised** - Areas of concern or pushback
3. **Fund Performance Discussion** - Performance metrics discussed
4. **Commitments Made** - Any commitments by either party
5. **Follow-up Materials** - Documents or data requested
6. **Action Items** - Next steps and timeline`,
    outputFormat: 'markdown',
    sortOrder: 3
  },
  {
    name: 'General Meeting',
    description: 'General-purpose meeting summary',
    category: 'general',
    systemPrompt: `You are a professional meeting summarizer. Create clear, actionable summaries that capture the key points, decisions, and follow-up items from meetings.`,
    userPromptTemplate: `Summarize the following meeting.

Meeting: {{meeting_title}}
Date: {{date}}
Duration: {{duration}}
Participants: {{speakers}}

## Transcript:
{{transcript}}

Please provide:
1. **Attendees** - Who was present
2. **Agenda Items** - Topics discussed
3. **Key Points** - Important information shared
4. **Decisions** - Decisions made during the meeting
5. **Action Items** - Tasks with owners and deadlines`,
    outputFormat: 'markdown',
    sortOrder: 4
  }
]
