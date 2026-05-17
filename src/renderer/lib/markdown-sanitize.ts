// markdown-sanitize.ts
//
// Calibrated sanitize schema for SafeMarkdown. Allows the tags + attrs that
// real AI-emitted markdown actually uses in this codebase, plus the inline
// <mark> sentinel that find-in-page injects via injectFindMarks.
//
// Calibration: 2026-05-16, sample of 195 strings from chat_session_messages,
// investment_memo_versions.content_markdown, notes, and on-disk summary/
// transcript .md files. Driver: scripts/survey-markdown-html.ts.
//
// Observed tags (frequency): br=88, u=63, img=20, sup=1.
// Observed img attrs: src, alt, style. style is intentionally NOT in the
// schema — it is a CSS-context XSS vector and inline image sizing degrades
// gracefully to the default layout.
//
// Re-run the survey script after any model upgrade — see
// TODOS.md ("Re-run markdown HTML survey after model upgrades").
//
// TODO(cross-platform): move to a shared package when the web/mobile apps
// render the same content. Today, web uses react-markdown with no rehype-raw
// and no sanitizer (safe by accident); mobile is unbuilt.

import { defaultSchema } from 'hast-util-sanitize'
import type { Schema } from 'hast-util-sanitize'

const baseTagNames = defaultSchema.tagNames ?? []
const baseAttributes = defaultSchema.attributes ?? {}

export const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...baseTagNames,
    'mark', // find-in-page highlight via injectFindMarks
    'u', // underline — used by Tiptap-edited user notes
  ],
  attributes: {
    ...baseAttributes,
    // <mark className="markActive"> distinguishes the active find match.
    mark: [['className', 'markActive']],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    src: ['http', 'https', 'data', 'asset', 'media'],
  },
}
