# Cyggie MCP Server

This folder implements the Cyggie gateway's [Model Context Protocol](https://modelcontextprotocol.io) server. It exposes Cyggie's CRM data to external agents (Slack bot, Claude Desktop, Cursor, future Zapier webhooks) over a single authenticated HTTP endpoint.

## Status — Slice 8 (External Agents V1)

**Auth is dev-bypass only.** Production OAuth lands in Slice 9 (`node-oidc-provider`). **Do not ship this branch to production with `CYGGIE_MCP_DEV_TOKEN` set in env.** Slice 9 deletes `dev-auth.ts` outright.

## Surface

`POST /mcp` — Streamable HTTP MCP transport (stateless mode). The endpoint accepts standard JSON-RPC 2.0 MCP requests.

### Tools registered

| Tool | Purpose |
|---|---|
| `cyggie_search` | Universal search across companies, contacts, meetings, notes. |
| `cyggie_get_company` | Fuzzy-resolve a company by name/domain/id → detail block. |
| `cyggie_get_contact` | Fuzzy-resolve a contact by name/email/id → detail block. |
| `cyggie_recent_meetings` | List recent meetings filtered by company OR contact. |
| `cyggie_get_meeting` | Fetch one meeting by id (notes + summary + transcript). |
| `cyggie_get_notes` | List notes by attachment or FTS query (requires ≥1 filter). |

**`cyggie_ask` is intentionally NOT exposed on MCP in V1** (decision-log #21). Interactive MCP clients (Claude Desktop, Cursor) have their own LLM; they should drive the structured tools directly. `cyggie_ask` returns to MCP when the Slack bot splits out to its own Fly app in the multi-firm rollout.

## Public API contract

The tool **names**, **input shapes**, and **error codes** in [`server.ts`](./server.ts) + [`tools/*`](./tools/) + [`../shared/error-envelope.ts`](../shared/error-envelope.ts) are a **public API contract**. External clients (Claude Desktop installs, scripted MCP callers, future Zapier integrations) depend on these signatures.

**Adding a new tool is safe.** Renaming or removing one — or changing the input schema — is a breaking change. Prefer adding new tools to mutating existing ones. See the [`withSync` barrel rule in CLAUDE.md](../../../CLAUDE.md) for the same pattern applied to DB writes.

Error codes (stable enum from [`error-envelope.ts`](../shared/error-envelope.ts)):

```
NOT_FOUND           No row matches the query.
AMBIGUOUS           Multiple rows match; caller should disambiguate.
INVALID_INPUT       Input failed validation or required fields missing.
PERMISSION_DENIED   Authorization or DB permission denied.
TOOL_DISABLED       Tool's feature flag is off (e.g. cyggie_execute_sql).
TIMEOUT             Tool exceeded its time budget.
INTERNAL            Unexpected error; check server logs / Sentry.
```

## Local development

```bash
# 1. Set the dev token in .env.local (32+ chars):
echo 'CYGGIE_MCP_DEV_TOKEN="'"$(openssl rand -base64 32)"'"' >> .env.local

# 2. (Optional) Override which user the dev token impersonates:
echo 'MCP_DEV_USER_ID="<your-cyggie-user-cuid>"' >> .env.local

# 3. Run the gateway in dev.
pnpm --filter @cyggie/api-gateway dev

# 4. Smoke-test with MCP Inspector.
npx @modelcontextprotocol/inspector

#    In Inspector: connect to http://127.0.0.1:8443/mcp
#    Auth header: Bearer <your-CYGGIE_MCP_DEV_TOKEN>
#    Then call any tool with realistic args.
```

## Feature flags

| Env var | Default | Purpose |
|---|---|---|
| `CYGGIE_MCP_ENABLED` | `true` | Emergency disable for the entire MCP route. When `false`, `POST /mcp` returns 404. |
| `CYGGIE_MCP_DEV_TOKEN` | unset | Dev-only static bearer token. Unset = `/mcp` requires OAuth (which doesn't exist until slice 9 = endpoint effectively closed). |
| `CYGGIE_MCP_SQL_ENABLED` | `false` | (Slice 10) Gates the `cyggie_execute_sql` tool. Stays `false` in prod until firm_id denormalization (T3). |

## Architecture

```
POST /mcp (Fastify route, route.ts)
    │
    ├─ verifyDevToken(req, env)              dev-auth.ts
    │     ├─ no token in env  → 401 AUTH_NOT_CONFIGURED
    │     ├─ no Authorization → 401 MISSING_TOKEN
    │     └─ token mismatch   → 401 INVALID_TOKEN
    │
    ├─ buildMcpServer({ db, userId, log })   server.ts
    │     └─ registers 6 tools, each wrapped with
    │        runWithInstrumentation (Sentry breadcrumbs +
    │        metric=mcp.tool.invocations log lines)
    │
    ├─ new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    │     │     (stateless — no Mcp-Session-Id; each POST is self-contained)
    │
    └─ transport.handleRequest(req.raw, reply.raw, req.body)
          │     SDK writes JSON-RPC reply directly to res.raw
          │     (Fastify hijacked via reply.hijack())
          ▼
       Tool handler closure → cyggieXxx({ db, userId, ... }) → ToolResult
                                                                    │
                                                                    ▼
                            toolResultToCallToolResult (envelope-bridge.ts)
                                                                    │
                                                                    ▼
                                                            CallToolResult
```

## Observability

- **Sentry breadcrumbs**: every `/mcp` request entry + every tool invocation entry.
- **Sentry captures**: tool handler thrown errors (tagged `mcp_tool: <name>`), security failures (signing/auth — covered by the route handler).
- **Structured pino logs** (matching existing `metric=...` pattern):
  - `metric=mcp.tool.invocations{tool, ok, duration_ms}` per successful call
  - `metric=mcp.tool.errors{tool, error_code, duration_ms}` per error envelope or thrown error
  - `metric=mcp.auth.fail{error_code}` per failed auth attempt

## What's NOT in slice 8

- OAuth 2.0 server (slice 9)
- `cyggie_execute_sql` tool (slice 10; flag-gated even when shipped)
- `cyggie_ask` exposed on MCP (multi-firm follow-up after Slack splits out)
- Stateful session mode + `Mcp-Session-Id` (V1 is stateless; V2 if needed)
- Rate limiting (deferred to multi-firm per decision-log #14)
