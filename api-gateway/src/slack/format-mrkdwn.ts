// Slack mrkdwn helpers (External Agents V1 slice 2+).
//
// Slack's mrkdwn flavor is NOT standard markdown:
//   bold:   *text*           (single asterisk; **text** renders literally)
//   italic: _text_
//   code:   `text`
//   block:  ```text```
//   link:   <url|display>    (NOT [display](url))
//   bullet: • text           (literal bullet works; - also works in some clients)
//
// This module gives the Slack handlers a small set of building-block
// functions instead of forcing them to remember the syntax inline.
// Slice 5 will add a generic markdown→mrkdwn converter on top of these
// for the LLM's free-form output; slice 2 only needs the building
// blocks because the search formatter constructs mrkdwn directly.

// Characters that mean something in mrkdwn and need escaping when
// they're part of user-provided strings (company names, query strings).
// Per Slack docs, only & < > require HTML-entity escaping; the rest
// (*, _, `, ~) are formatting markers but Slack treats them as
// literal when they're not part of a complete pair, so escaping isn't
// strictly required and would render uglily.
//
// We escape only the three control characters Slack documents.
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function bold(s: string): string {
  return `*${escapeMrkdwn(s)}*`
}

export function italic(s: string): string {
  return `_${escapeMrkdwn(s)}_`
}

export function code(s: string): string {
  return `\`${s}\``
}

// Slack link. The pipe-escape inside display is per Slack docs — the
// `|` separator can't appear in the display text raw.
export function link(url: string, display?: string): string {
  if (!display) return `<${url}>`
  const safe = display.replace(/\|/g, '∣') // U+2223 looks like | but isn't
  return `<${url}|${escapeMrkdwn(safe)}>`
}

// Bullet line. Using a literal • (bullet) instead of `-` because some
// Slack desktop clients render `-` as plain text in a slash-command
// response, while • always renders as a bullet glyph.
export function bullet(s: string): string {
  return `•  ${s}`
}
