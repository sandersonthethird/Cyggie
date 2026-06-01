// Minimal consent + "need login" HTML screens for the OAuth interaction
// flow.
//
// V1 stub: bare HTML, no CSS framework, no client-side JS. Slice 9
// acceptance bar is "Claude Desktop install completes end-to-end";
// polish is a follow-up. The pages render fast, work without
// JavaScript, and the consent prompt names the client + scopes so the
// user can make an informed choice.

import { escape as escapeHtml } from 'node:querystring'

// node:querystring escape is URL-encode; for HTML we want entity-encode.
// Tiny helper inline to avoid a dependency. Only & < > " ' matter for
// the trusted-content surface (client_name, scope names) we render.
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}
// querystring.escape import kept above so future URL building uses it
// rather than reimporting separately. Suppress unused-import on the no-JS path.
void escapeHtml

// Friendly labels for the cyggie:* scopes — surfaced on the consent
// screen so the user sees "Read your CRM data" instead of bare
// "cyggie:read". Unknown scopes fall back to the literal name.
const SCOPE_LABELS: Record<string, string> = {
  'cyggie:read': 'Read your Cyggie CRM (companies, contacts, meetings, notes).',
  'cyggie:ask': "Ask natural-language questions answered by Cyggie's AI.",
  'cyggie:sql':
    'Run read-only SQL queries against your CRM (advanced; gated for trusted clients only).',
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}

export interface RenderConsentArgs {
  interactionUid: string
  clientName: string
  scopes: string[]
}

export function renderConsentScreen(args: RenderConsentArgs): string {
  const { interactionUid, clientName, scopes } = args
  const scopeItems = scopes
    .map((s) => `<li><code>${htmlEscape(s)}</code> — ${htmlEscape(scopeLabel(s))}</li>`)
    .join('\n        ')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${htmlEscape(clientName)} — Cyggie</title>
  <style>
    body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 480px;
           margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; margin-bottom: 0.4rem; }
    .sub { color: #666; margin-top: 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem;
            margin-top: 1.5rem; background: #fafafa; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.4rem 0; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { font: inherit; padding: 0.6rem 1.25rem; border-radius: 6px;
             border: 1px solid #ccc; cursor: pointer; }
    .allow { background: #1a73e8; color: white; border-color: #1a73e8; }
    .deny  { background: white; color: #333; }
    code { background: #eef; padding: 0 4px; border-radius: 3px; font-size: 0.9em; }
    .footer { color: #888; margin-top: 2rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Authorize <strong>${htmlEscape(clientName)}</strong>?</h1>
  <p class="sub">This application is requesting access to your Cyggie data.</p>

  <div class="card">
    <p><strong>${htmlEscape(clientName)}</strong> will be able to:</p>
    <ul>
        ${scopeItems}
    </ul>
  </div>

  <form method="POST" action="/oauth/interaction/${htmlEscape(interactionUid)}/confirm">
    <input type="hidden" name="_csrf" value="">
    <div class="actions">
      <button type="submit" name="decision" value="allow" class="allow">Allow</button>
      <button type="submit" name="decision" value="deny"  class="deny">Deny</button>
    </div>
  </form>

  <p class="footer">
    You can revoke this access anytime in Cyggie Settings → Connected Apps.
    (Settings UI lands in a follow-up; until then, contact your admin.)
  </p>
</body>
</html>`
}

export interface RenderNeedLoginArgs {
  interactionUid: string
  clientName: string
  baseUrl: string
}

export function renderNeedLoginScreen(args: RenderNeedLoginArgs): string {
  const { interactionUid, clientName, baseUrl } = args
  const returnTo = `/oauth/interaction/${interactionUid}`
  // V1 stub: we don't yet wire Google login's redirect_target to bring
  // the user back to the interaction. The user has to: (1) click the
  // login link, (2) complete Google sign-in, (3) re-visit the
  // /oauth/interaction/:uid URL from their browser history. Slice 9.5
  // follow-up: extend /auth/google/start with a `next` param that the
  // callback honors as the post-auth redirect target.
  const loginUrl = `${baseUrl}/auth/google/start?redirect_target=desktop`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Cyggie</title>
  <style>
    body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 480px;
           margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; }
    .actions { margin-top: 1.5rem; }
    a.button { display: inline-block; padding: 0.6rem 1.25rem; border-radius: 6px;
               background: #1a73e8; color: white; text-decoration: none; }
    .step { color: #555; margin: 0.4rem 0; }
    .footer { color: #888; margin-top: 2rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Sign in to authorize ${htmlEscape(clientName)}</h1>
  <p>You need an active Cyggie session before you can grant access.</p>
  <ol>
    <li class="step">Click the button below to sign in via Google.</li>
    <li class="step">After sign-in, return to this URL: <code>${htmlEscape(returnTo)}</code></li>
    <li class="step">You'll then see the consent screen for <strong>${htmlEscape(clientName)}</strong>.</li>
  </ol>
  <div class="actions">
    <a href="${htmlEscape(loginUrl)}" class="button">Sign in with Google</a>
  </div>
  <p class="footer">
    V1 limitation: post-login auto-redirect lands in a slice 9 follow-up.
    For now you'll need to navigate back to the URL above manually.
  </p>
</body>
</html>`
}
