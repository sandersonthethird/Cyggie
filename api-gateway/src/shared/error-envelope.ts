// Shared MCP tool result envelope.
//
// Per External Agents V1 plan decision-log #25, MCP tools and REST routes
// use the SAME error shape — `{ error: { code, message, details? } }` —
// so clients only learn one envelope. The success branch wraps a markdown
// string in `{ result }` plus an optional top-level `cyggieUrl` deep
// link back to the desktop/web app for single-entity tools.
//
// Implements the **public API contract** for MCP tools. Changing
// signatures here breaks external installs; add new fields/codes rather
// than mutating existing ones. Mirror this rule in CLAUDE.md when
// slice 8 ships.

// Stable enum of error codes. Tools should prefer these over ad-hoc
// strings so clients can branch reliably. String fallback (rather than
// `ErrorCode` strict typing) preserves forward compatibility — a tool
// can return a future code without breaking older clients that don't
// recognize it.
export const ERROR_CODE = {
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TOOL_DISABLED: 'TOOL_DISABLED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

export interface ToolError {
  error: {
    code: ErrorCode | string
    message: string
    details?: unknown
  }
}

export interface ToolSuccess {
  result: string
  cyggieUrl?: string
}

export type ToolResult = ToolSuccess | ToolError

export function isToolError(r: ToolResult): r is ToolError {
  return 'error' in r
}

export function ok(result: string, cyggieUrl?: string): ToolSuccess {
  return cyggieUrl ? { result, cyggieUrl } : { result }
}

export function err(
  code: ErrorCode | string,
  message: string,
  details?: unknown,
): ToolError {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  }
}
