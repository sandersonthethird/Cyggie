// Renderer-local mirror of the chat contextId helper.
//
// chat_sessions.contextId is stored as "<kind>:<entity-id>". The canonical
// implementation lives in packages/shared/src/chat-context-id.ts, but that
// package is outside the renderer tsconfig project (tsconfig.web.json only
// includes src/renderer and src/shared), so the renderer keeps a local copy
// of this trivial, behavior-identical helper.
//
// Idempotent: a bare ID (no prefix) is returned unchanged.
export function stripContextIdPrefix(kind: string, raw: string): string {
  const prefix = `${kind}:`
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
}
