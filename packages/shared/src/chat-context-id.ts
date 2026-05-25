// chat_sessions.contextId is stored as "<kind>:<entity-id>" by both
// desktop (src/renderer/components/chat-panel/ChatPanelRoot.tsx) and
// mobile (mobile/app/{companies,meetings,contacts}/[id].tsx).
//
// The kind: prefix prevents cross-kind collisions on
// chat_sessions_active_idx (a uniqueIndex on contextId alone — see
// packages/db/src/schema/chat.ts:74). Every consumer that needs to
// look up the underlying entity must strip it first.
//
// Idempotent: a bare ID (no prefix) is returned unchanged. This keeps
// the helper safe for any legacy bare-ID rows and for callers that
// can't be sure whether their input has been pre-stripped.
export function stripContextIdPrefix(kind: string, raw: string): string {
  const prefix = `${kind}:`
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
}
