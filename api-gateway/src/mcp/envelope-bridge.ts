// Bridges Cyggie's internal ToolResult envelope (api-gateway/src/shared/
// error-envelope.ts — used by REST routes and MCP tools alike per
// decision-log #25) to the MCP wire-format CallToolResult shape required
// by @modelcontextprotocol/sdk.
//
// Why a bridge layer instead of having tools return CallToolResult directly:
//   - Tools are reusable beyond MCP (slice 5's cyggieAsk wrapper consumes
//     ToolResult in-process; slice 8's MCP handler consumes the same shape
//     via this bridge).
//   - Tools stay framework-agnostic; this file is the only one that knows
//     about MCP's wire format.
//   - Keeps the public API contract (the error/code namespace) in one
//     place — see api-gateway/src/shared/error-envelope.ts.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isToolError, type ToolResult } from '../shared/error-envelope'

// Re-export the SDK's wire-format type so call sites only need to import
// from this bridge — keeps the MCP-SDK coupling in one file.
export type McpCallToolResult = CallToolResult

export function toolResultToCallToolResult(r: ToolResult): CallToolResult {
  if (isToolError(r)) {
    return {
      content: [
        {
          type: 'text',
          text: `[${r.error.code}] ${r.error.message}`,
        },
      ],
      isError: true,
      _meta: {
        code: r.error.code,
        ...(r.error.details !== undefined ? { details: r.error.details } : {}),
      },
    }
  }
  return {
    content: [{ type: 'text', text: r.result }],
    ...(r.cyggieUrl ? { _meta: { cyggieUrl: r.cyggieUrl } } : {}),
  }
}
