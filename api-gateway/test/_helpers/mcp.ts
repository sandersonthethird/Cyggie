import type { FastifyInstance } from 'fastify'

// Shared MCP JSON-RPC test helpers (Issue 5A) — dedupes the copies that were
// living in mcp-smoke.test.ts and reused by the per-tool + OAuth suites.

export interface McpToolResult {
  isError?: boolean
  _meta?: { code?: string; [k: string]: unknown }
  content?: Array<{ type?: string; text?: string }>
}

interface JsonRpcEnvelope {
  result?: unknown
  error?: { code: number; message: string }
}

export function jsonRpc(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): { jsonrpc: '2.0'; id: number; method: string; params: Record<string, unknown> } {
  return { jsonrpc: '2.0', id, method, params }
}

// The /mcp route may answer as plain JSON or as an SSE `data:` frame depending
// on content negotiation. Parse either into the JSON-RPC envelope.
export function parseJsonRpcResponse(body: string): JsonRpcEnvelope {
  try {
    const parsed = JSON.parse(body)
    return (Array.isArray(parsed) ? parsed[0] : parsed) as JsonRpcEnvelope
  } catch {
    const m = /^data:\s*(.+)$/m.exec(body)
    if (!m) throw new Error(`Cannot parse MCP response: ${body.slice(0, 200)}`)
    const parsed = JSON.parse(m[1])
    return (Array.isArray(parsed) ? parsed[0] : parsed) as JsonRpcEnvelope
  }
}

// POST a tools/call to /mcp with a bearer token and return the unwrapped
// CallToolResult (content + isError + _meta.code). Error envelopes surface the
// stable code at `_meta.code` (see api-gateway/src/mcp/envelope-bridge.ts).
export async function callTool(
  app: FastifyInstance,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: jsonRpc('tools/call', { name, arguments: args }),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
  })
  const env = parseJsonRpcResponse(res.body)
  return (env.result ?? {}) as McpToolResult
}
