import TurndownService from 'turndown'

export interface ExtractedImage {
  mimeType: string  // 'png' | 'jpeg' | 'jpg' | 'gif' | 'webp'
  data: string      // raw base64 string (no data URI prefix)
}

export interface HtmlToMarkdownResult {
  markdown: string       // with __IMG_{n}__ placeholders where images were
  images: ExtractedImage[]
}

const ALLOWED_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i
const DATA_IMG_RE = /<img[^>]+src="(data:image\/(png|jpe?g|gif|webp);base64,([^"]+))"[^>]*>/gi

// Matches individual <li>...</li> elements within a <ul> inner HTML block.
// Module-scope (no /g flag) so matchAll() can be used safely without lastIndex state.
const GDOCS_LI_RE = /<li[^>]*>[\s\S]*?<\/li>/

/**
 * Preprocesses Google Docs exported HTML to fix its non-standard list structure.
 *
 * Google Docs exports nested lists as flat sibling <ul> elements, encoding
 * nesting level in a CSS class suffix (lst-kix_LISTID-N). Turndown cannot
 * produce indented markdown from flat siblings — it sees them as separate lists.
 *
 * This function:
 *   1. Finds all <ul> blocks with lst-kix_ classes
 *   2. Groups consecutive blocks with the same listId (allowing empty <p> between)
 *   3. Reconstructs each group as a properly nested <ul> tree
 *   4. Replaces the original flat blocks in-place (working backwards to preserve indices)
 *
 * Non-Google-Docs HTML is returned unchanged (fast-path: no 'lst-kix_' present).
 *
 * Level-jump handling:
 *   Upward skip (0→2):  pushes new frame without intermediary — produces correct nesting
 *   Downward multi-jump (4→0): flushes frames 4,3,2,1 in sequence, each attaching to parent
 *
 * Data flow:
 *   html → detect → extract blocks → group runs → buildNestedList per run → replace → html'
 */
function preprocessGoogleDocsLists(html: string): string {
  if (!html.includes('lst-kix_')) return html

  // Match each <ul class="... lst-kix_LISTID-LEVEL ...">...</ul>
  // Captures: [1]=listId, [2]=level, [3]=innerHtml
  const UL_RE = /<ul[^>]+class="[^"]*lst-kix_([a-z0-9]+)-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/ul>/g

  type Block = { start: number; end: number; listId: string; level: number; inner: string }
  const blocks: Block[] = []
  let m: RegExpExecArray | null
  UL_RE.lastIndex = 0
  while ((m = UL_RE.exec(html)) !== null) {
    blocks.push({
      start: m.index,
      end: m.index + m[0].length,
      listId: m[1],
      level: parseInt(m[2], 10),
      inner: m[3],
    })
  }
  if (blocks.length === 0) return html

  // Group consecutive blocks with the same listId.
  // Blocks may be separated by empty <p> tags (Google Docs artifact) —
  // strip HTML tags from the gap and check for non-whitespace.
  type Run = { blocks: Block[] }
  const runs: Run[] = []
  let currentRun: Block[] = [blocks[0]]

  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]
    const curr = blocks[i]
    const between = html.slice(prev.end, curr.start)
    const betweenText = between.replace(/<[^>]+>/g, '').trim()
    if (curr.listId === prev.listId && betweenText === '') {
      currentRun.push(curr)
    } else {
      runs.push({ blocks: currentRun })
      currentRun = [curr]
    }
  }
  runs.push({ blocks: currentRun })

  console.log(`[html-to-markdown] preprocessGoogleDocsLists: ${blocks.length} blocks → ${runs.length} runs`)

  // Replace runs in reverse order to preserve string indices
  let result = html
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]
    const start = run.blocks[0].start
    const end = run.blocks[run.blocks.length - 1].end
    const nested = buildNestedList(run.blocks.map(b => ({ level: b.level, inner: b.inner })))
    if (!nested) {
      console.warn('[html-to-markdown] buildNestedList returned empty — preserving original HTML for run')
      // Original HTML already present in result; skip substitution
      continue
    }
    result = result.slice(0, start) + nested + result.slice(end)
  }
  return result
}

/**
 * Converts a flat sequence of {level, inner} list blocks into a properly nested
 * HTML <ul> tree using a stack-based algorithm.
 *
 * Stack invariant: frames are in increasing level order (bottom = lowest level).
 * "String surgery": when closing a deeper frame, the resulting <ul> is inserted
 * immediately before the </li> of the parent frame's last item.
 *
 * Handles:
 *   - Downward multi-jumps (e.g. 4→0): flushes frames one-by-one
 *   - Upward level skips (e.g. 0→2): pushes new frame, no intermediary needed
 *   - Same-level continuation: extends current frame's items
 *
 * Returns '' if all blocks contain no parseable <li> elements (content preserved
 * by caller, which logs a warning and keeps the original HTML).
 */
function buildNestedList(blocks: Array<{ level: number; inner: string }>): string {
  type Frame = { level: number; items: string[] }
  const stack: Frame[] = []

  // Close all frames deeper than targetLevel, attaching each as a child <ul>
  // to the last <li> of the frame below it. stack.length > 1 guards the root.
  function flushToLevel(targetLevel: number): void {
    while (stack.length > 1 && stack[stack.length - 1].level > targetLevel) {
      const frame = stack.pop()!
      const nestedUl = `<ul>\n${frame.items.join('\n')}\n</ul>`
      const parent = stack[stack.length - 1]
      if (parent.items.length > 0) {
        const last = parent.items[parent.items.length - 1]
        // Insert nested <ul> immediately before the closing </li>
        parent.items[parent.items.length - 1] = last.replace(/<\/li>\s*$/, `\n${nestedUl}</li>`)
      }
    }
  }

  for (const block of blocks) {
    const liItems = [...block.inner.matchAll(new RegExp(GDOCS_LI_RE.source, 'g'))].map(x => x[0])
    if (liItems.length === 0) continue

    const top = stack[stack.length - 1]

    if (!top || top.level < block.level) {
      // Going deeper (or first block)
      stack.push({ level: block.level, items: liItems })
    } else if (top.level === block.level) {
      // Same level — extend
      top.items.push(...liItems)
    } else {
      // Going shallower — flush frames deeper than this level, then extend or push
      flushToLevel(block.level)
      const newTop = stack[stack.length - 1]
      if (newTop && newTop.level === block.level) {
        newTop.items.push(...liItems)
      } else {
        stack.push({ level: block.level, items: liItems })
      }
    }
  }

  // Flush all remaining frames into the root
  while (stack.length > 1) {
    const frame = stack.pop()!
    const nestedUl = `<ul>\n${frame.items.join('\n')}\n</ul>`
    const parent = stack[stack.length - 1]
    if (parent.items.length > 0) {
      const last = parent.items[parent.items.length - 1]
      parent.items[parent.items.length - 1] = last.replace(/<\/li>\s*$/, `\n${nestedUl}</li>`)
    }
  }

  if (stack.length === 1) {
    return `<ul>\n${stack[0].items.join('\n')}\n</ul>`
  }
  return ''
}

/**
 * Single-pass HTML → Markdown conversion.
 * Extracts base64-embedded images first (replacing with __IMG_{n}__ tokens),
 * preprocesses Google Docs flat list structure into proper nesting,
 * then runs Turndown. Returns both the converted Markdown and the extracted
 * images in placeholder order, ready for disk write.
 *
 * On any conversion error, returns { markdown: '', images: [] } — caller treats as skip.
 */
export function convertHtmlToMarkdown(html: string): HtmlToMarkdownResult {
  try {
    const images: ExtractedImage[] = []

    // Single-pass: replace whitelisted base64 <img> tags with __IMG_{n}__ placeholders
    const substituted = html.replace(DATA_IMG_RE, (_match, _dataUri, rawMime, base64) => {
      const mime = rawMime.toLowerCase().replace('jpg', 'jpeg')
      if (!ALLOWED_MIME_RE.test(`image/${mime}`)) return _match  // leave non-whitelisted as-is
      const idx = images.length
      images.push({ mimeType: mime, data: base64 })
      return `__IMG_${idx}__`
    })

    // Pre-process Google Docs flat list structure into proper nesting before Turndown
    const preprocessed = preprocessGoogleDocsLists(substituted)

    const td = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
    })

    const markdown = td.turndown(preprocessed)
    return { markdown, images }
  } catch {
    return { markdown: '', images: [] }
  }
}
