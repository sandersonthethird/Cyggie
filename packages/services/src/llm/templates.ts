// =============================================================================
// templates.ts — desktop summarizer prompt assembly.
//
// T25: the buildPrompt logic + grounding-instruction constants moved to the
// shared kernel (@cyggie/shared → packages/shared/src/llm/meeting-prompt.ts)
// so the gateway enhance route and the desktop summarizer share ONE
// implementation. This file is now a thin re-export to preserve the existing
// import surface (summarizer.ts, templates.test.ts, summary-prompt-instructions.test.ts).
//
// buildPrompt accepts the structural PromptTemplate; desktop's MeetingTemplate
// (with id/category/outputFormat/…) satisfies it.
// =============================================================================

export {
  buildPrompt,
  AUTHORITATIVE_ATTENDEES_INSTRUCTION,
  ANTI_FABRICATION_INSTRUCTION,
  AUTHORITATIVE_COMPANY_INSTRUCTION,
  type PromptContext,
  type PromptTemplate,
} from '@cyggie/shared'
