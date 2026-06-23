// M5 PR3 — the don't-touch-untouched save guard (review decision 4A/3A), pulled
// out of the note screen so it's unit-testable without rendering the WebView.
//
// Notes are markdown-canonical. The rich editor works in HTML, so saving an
// edited note round-trips md↔html — which can lose fidelity. To guarantee that
// opening a (possibly desktop-authored) note and saving it WITHOUT edits never
// corrupts it, we only extract from the editor when the body was actually
// changed; otherwise the original markdown is saved verbatim.
//
//   richEnabled? ──no──▶ draftContent (plain TextInput is already markdown)
//        │yes
//   dirty + getMarkdown? ──no──▶ draftContent (VERBATIM — untouched note)
//        │yes
//   getMarkdown() ──throws──▶ draftContent (never lose the note on extract error)
//        │ok
//   ▼ extracted markdown

export async function resolveNoteSaveContent(opts: {
  richEnabled: boolean
  dirty: boolean
  draftContent: string
  getMarkdown?: (() => Promise<string>) | null
}): Promise<string> {
  const { richEnabled, dirty, draftContent, getMarkdown } = opts
  if (richEnabled && dirty && getMarkdown) {
    try {
      return await getMarkdown()
    } catch {
      return draftContent
    }
  }
  return draftContent
}
