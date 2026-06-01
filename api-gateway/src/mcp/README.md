# Cyggie MCP Server

This folder implements the Cyggie gateway's [Model Context Protocol](https://modelcontextprotocol.io) server. It exposes Cyggie's CRM data to external agents (Slack bot, Claude Desktop, Cursor, future Zapier webhooks) over a single authenticated HTTP endpoint.

## Status — Slice 9 (External Agents V1)

**Auth is OAuth 2.0** via `node-oidc-provider` (see [`api-gateway/src/oauth/`](../oauth/)). The slice 8 dev-bypass token has been removed; the MCP route verifies JWT bearer tokens issued by the OAuth server. Token requirements: `aud: 'cyggie-mcp'`, HS256-signed with the gateway's `JWT_SIGNING_SECRET`, scope must include `cyggie:read`.

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
| `cyggie_execute_sql` | (Flag + scope gated.) Read-only SQL against the CRM. Requires `CYGGIE_MCP_SQL_ENABLED=true` AND the caller's OAuth token to carry the `cyggie:sql` scope. See [tools/execute-sql.ts](./tools/execute-sql.ts) for the allowlist + safety design. |

**`cyggie_ask` is intentionally NOT exposed on MCP in V1** (decision-log #21). Interactive MCP clients (Claude Desktop, Cursor) have their own LLM; they should drive the structured tools directly. `cyggie_ask` returns to MCP when the Slack bot splits out to its own Fly app in the multi-firm rollout.

### Enabling `cyggie_execute_sql`

Two-step opt-in (both required):

1. **Provision the read-only Postgres role** in Neon. The full `GRANT` script (which tables, which to REVOKE) is the `ROLE_GRANT_SCRIPT` export at the top of [api-gateway/src/db/readonly-pool.ts](../db/readonly-pool.ts). Run it once as a Neon admin, then copy the resulting connection string into `NEON_READONLY_URL`.
2. **Set `CYGGIE_MCP_SQL_ENABLED=true`** in env. The gateway will register the tool on next boot. Clients with `cyggie:sql` scope can then call it; clients without the scope see `PERMISSION_DENIED`.

The Postgres role itself is the load-bearing security boundary — the application code can't bypass its `SELECT` grants even if it tried. Application-layer guardrails (pre-flight validation, statement timeout, output cap) are belt-and-suspenders on top of that.

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
# 1. Run the gateway in dev (OAuth server boots alongside MCP).
pnpm --filter @cyggie/api-gateway dev

# 2. Register a client via DCR (dynamic client registration).
curl -X POST http://127.0.0.1:8443/oauth/reg \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "MCP Inspector (dev)",
    "redirect_uris": ["http://localhost:6274/oauth/callback"],
    "grant_types": ["authorization_code", "refresh_token"]
  }'
# → returns { client_id, client_secret, ... }

# 3. Connect MCP Inspector:
npx @modelcontextprotocol/inspector

#    In Inspector: connect to http://127.0.0.1:8443/mcp
#    Auth: OAuth 2.0 (Inspector will discover the AS via
#    /.well-known/oauth-authorization-server, pop a browser for consent,
#    receive a JWT, and use it as the Bearer token automatically).
```

For Claude Desktop / Cursor / other MCP clients, point them at `http://127.0.0.1:8443/mcp` and let them discover OAuth from the metadata endpoint.

## Feature flags

| Env var | Default | Purpose |
|---|---|---|
| `CYGGIE_MCP_ENABLED` | `true` | Emergency disable for the entire MCP route. When `false`, `POST /mcp` returns 404. |
| `CYGGIE_PUBLIC_BASE_URL` | `http://${HOST}:${PORT}` | Public base URL used by the OAuth server for issuer + redirect URLs. Set in prod (e.g. `https://cyggie-gateway.fly.dev`). |
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
