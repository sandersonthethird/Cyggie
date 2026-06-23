import type { MeetingTemplateSeed } from '../types/template'
import { CANONICAL_MEETING_TEMPLATES } from '@cyggie/shared'

// T25: the 5 default templates now live in the shared kernel
// (@cyggie/shared → packages/shared/src/constants/meeting-templates.ts) so the
// desktop seed, the gateway enhance route, and the mobile picker can't drift.
// This file maps the canonical definitions into the desktop seed shape
// (MeetingTemplateSeed adds outputFormat + sortOrder; everything else is
// byte-identical to the canonical source).
export const DEFAULT_TEMPLATES: MeetingTemplateSeed[] = CANONICAL_MEETING_TEMPLATES.map(
  (t, index) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    systemPrompt: t.systemPrompt,
    userPromptTemplate: t.userPromptTemplate,
    outputFormat: 'markdown',
    sortOrder: index,
  }),
)
