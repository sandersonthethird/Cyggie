/**
 * Memo section roster — shared between main and renderer.
 *
 * The full roster (with kind, required flag, gate predicate) lives in
 * `src/main/llm/memo/sections.ts` and re-exports MEMO_SECTION_HEADINGS from
 * here. The renderer needs only the ordered heading list to drive the
 * during-generation progress UI and the section-refresh nav, so we keep the
 * shared surface minimal.
 */

export const MEMO_SECTION_HEADINGS = [
  'Executive Summary',
  'Investment Thesis',
  'Business Description',
  'Product',
  'Market / Industry',
  'Competition',
  'Team',
  'Traction / Financials',
  'Go-To-Market',
  'Valuation',
  'Risks',
  'References',
] as const

export type MemoSectionHeading = (typeof MEMO_SECTION_HEADINGS)[number]
