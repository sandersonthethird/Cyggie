// SafeMarkdown.tsx
//
// Single entry point for rendering markdown in the renderer. Sanitizes raw
// HTML always — no opt-out. Replaces ad-hoc `<ReactMarkdown>` usages so
// `rehype-raw` cannot be enabled without also passing through `rehype-sanitize`.
//
// Data flow:
//
//   markdown string ──┐
//                     ├─► remarkGfm → MDAST → remark-rehype → HAST
//   findHighlight ────┘   (with `<mark>...</mark>` strings inlined by
//                          injectFindMarks when findHighlight is set)
//                                  │
//                                  ▼
//                          rehypeRaw (expand raw HTML nodes into elements)
//                                  │
//                                  ▼
//                          rehypeSanitize(markdownSanitizeSchema)
//                          (defaultSchema + 'mark' + 'u' + img src/data:)
//                                  │
//                                  ▼
//                          React element tree
//
// The pairing of rehypeRaw with rehypeSanitize is the documented
// "render HTML safely" recipe. rehypeRaw expands every `<script>`/`<img onerror>`
// payload into real HAST element nodes; rehypeSanitize then drops anything
// not in the schema. Without rehypeRaw, `<mark>` tags injected by
// `injectFindMarks` would render as escaped text and find-in-page would break.
//
// TODO(cross-platform): when web/mobile renders the same content shapes,
// move this component (and `markdown-sanitize.ts`) into a shared package.

import { memo } from 'react'
// eslint-disable-next-line no-restricted-imports
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { injectFindMarks, type FindMatch } from '../hooks/useFindInPage'
import { markdownSanitizeSchema } from '../lib/markdown-sanitize'

export interface FindHighlight {
  matches: FindMatch[]
  activeIndex: number
}

interface SafeMarkdownProps {
  children: string
  findHighlight?: FindHighlight
  className?: string
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]] as const

function SafeMarkdownInner({ children, findHighlight, className }: SafeMarkdownProps) {
  const content = findHighlight
    ? injectFindMarks(children, findHighlight.matches, findHighlight.activeIndex)
    : children

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rehypePlugins={REHYPE_PLUGINS as any}
      className={className}
    >
      {content}
    </ReactMarkdown>
  )
}

export const SafeMarkdown = memo(SafeMarkdownInner)
