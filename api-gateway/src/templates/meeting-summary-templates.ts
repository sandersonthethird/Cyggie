// =============================================================================
// Meeting-summary templates for /meetings/:id/enhance.
//
// T25: the 5 templates + the prompt-assembly logic now live in the shared
// kernel (@cyggie/shared). This module is a thin adapter that re-exports the
// canonical templates in the gateway's historical shape (`id` = the canonical
// `category`) plus the id helpers the route + the templates route + the zod
// enum depend on. The old hand-mirrored TEMPLATES array + substitutePlaceholders
// were deleted — the enhance route now builds prompts via buildPrompt from
// @cyggie/shared (same code path as the desktop summarizer).
// =============================================================================

import {
  CANONICAL_MEETING_TEMPLATES,
  MEETING_TEMPLATE_IDS,
  type MeetingTemplateCategory,
} from '@cyggie/shared'

export { AUTHORITATIVE_ATTENDEES_INSTRUCTION } from '@cyggie/shared'

export type TemplateId = MeetingTemplateCategory

export interface MeetingSummaryTemplate {
  id: TemplateId
  name: string
  description: string
  systemPrompt: string
  userPromptTemplate: string
}

export const TEMPLATES: readonly MeetingSummaryTemplate[] =
  CANONICAL_MEETING_TEMPLATES.map((t) => ({
    id: t.category,
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    userPromptTemplate: t.userPromptTemplate,
  }))

export const TEMPLATE_IDS = MEETING_TEMPLATE_IDS

export function findTemplate(id: string): MeetingSummaryTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
