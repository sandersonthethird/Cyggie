// Cyggie MCP server — Slice 8 (External Agents V1).
//
// Builds a per-request McpServer instance with the 6 structured read
// tools registered. Tools are pure async functions that take the
// per-request context (db + userId) via closure, returning the shared
// ToolResult envelope. The bridge layer translates that to MCP's
// CallToolResult wire format.
//
// `cyggie_ask` is intentionally NOT exposed on MCP in V1 per
// decision-log #21 — interactive MCP clients (Claude Desktop, Cursor)
// have their own LLM and should drive the structured tools directly.
// `cyggie_ask` will be added to MCP when the Slack bot splits to its
// own Fly app (multi-firm follow-up).
//
// Per-request instance pattern: each POST /mcp creates a fresh server
// + transport in stateless mode. Future stateful sessions would move
// to a per-session cache keyed by Mcp-Session-Id.

import type { FastifyBaseLogger } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { getDb } from '../db'
import { Sentry } from '../sentry'
import { toolResultToCallToolResult } from './envelope-bridge'
import { cyggieSearch } from './tools/search'
import { cyggieGetCompany } from './tools/get-company'
import { cyggieGetContact } from './tools/get-contact'
import { cyggieRecentMeetings } from './tools/recent-meetings'
import { cyggieGetMeeting } from './tools/get-meeting'
import { cyggieGetNotes } from './tools/get-notes'
import { cyggieExecuteSql } from './tools/execute-sql'
import type { GatewayEnv } from '../env'
import { err, ERROR_CODE, type ToolResult } from '../shared/error-envelope'

export interface BuildMcpServerArgs {
  env: GatewayEnv
  db: ReturnType<typeof getDb>
  userId: string
  // Scopes from the caller's OAuth access token. Used for per-tool
  // scope enforcement (e.g. cyggie_execute_sql requires cyggie:sql
  // even when the connection-level guard only checks cyggie:read).
  scopes: string[]
  log: FastifyBaseLogger
}

const SERVER_INFO = {
  name: 'cyggie',
  version: '0.1.0',
} as const

export function buildMcpServer(ctx: BuildMcpServerArgs): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } })
  const run = makeRunner(ctx)

  // cyggie_search ──────────────────────────────────────────────────────
  server.registerTool(
    'cyggie_search',
    {
      description:
        'Universal search across companies, contacts, meetings, and notes. ' +
        'Use this when the user references an entity by partial name or you ' +
        'need to disambiguate before calling a more specific tool. ' +
        'Cheap (DB-only) — prefer it over guessing.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Free-form search query.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Per-bucket max results (default 5, max 20).'),
      },
    },
    async (input) =>
      run('cyggie_search', () =>
        cyggieSearch({
          db: ctx.db,
          userId: ctx.userId,
          query: input.query,
          limit: input.limit,
        }),
      ),
  )

  // cyggie_get_company ─────────────────────────────────────────────────
  server.registerTool(
    'cyggie_get_company',
    {
      description:
        'Look up a single company by name, domain, or id. Returns full ' +
        'detail block (industry, stage, pipeline, financials, funding, ' +
        'investors, key takeaways) plus a cyggie:// deep link. ' +
        'On ambiguous match, returns an AMBIGUOUS error with a candidates ' +
        'list so the caller can disambiguate by id.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Company name, normalized name, or cuid2 id.'),
      },
    },
    async (input) =>
      run('cyggie_get_company', () =>
        cyggieGetCompany({ db: ctx.db, userId: ctx.userId, query: input.query }),
      ),
  )

  // cyggie_get_contact ─────────────────────────────────────────────────
  server.registerTool(
    'cyggie_get_contact',
    {
      description:
        'Look up a single contact by name, email, or id. Returns detail ' +
        'block (title, company, activity, investor profile if applicable, ' +
        'key takeaways) plus a cyggie:// deep link. AMBIGUOUS on duplicate ' +
        'normalized names.',
      inputSchema: {
        query: z.string().min(1).describe('Contact name, email, or cuid2 id.'),
      },
    },
    async (input) =>
      run('cyggie_get_contact', () =>
        cyggieGetContact({ db: ctx.db, userId: ctx.userId, query: input.query }),
      ),
  )

  // cyggie_recent_meetings ─────────────────────────────────────────────
  server.registerTool(
    'cyggie_recent_meetings',
    {
      description:
        'List recent meetings, optionally filtered by company OR contact ' +
        '(not both) and a "since" lower bound. Returns title + date + ' +
        'short summary snippet for each meeting plus a deep link. Use ' +
        'cyggie_get_meeting to fetch the full transcript for a specific ' +
        'meeting id.',
      inputSchema: {
        companyId: z
          .string()
          .optional()
          .describe('Filter to meetings linked to this company (cuid2).'),
        contactId: z
          .string()
          .optional()
          .describe('Filter to meetings the contact participated in (cuid2).'),
        since: z
          .string()
          .optional()
          .describe('ISO date — meetings on/after this date only.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max meetings to return (default 5, max 20).'),
      },
    },
    async (input) =>
      run('cyggie_recent_meetings', () =>
        cyggieRecentMeetings({
          db: ctx.db,
          userId: ctx.userId,
          companyId: input.companyId,
          contactId: input.contactId,
          since: input.since,
          limit: input.limit,
        }),
      ),
  )

  // cyggie_get_meeting ─────────────────────────────────────────────────
  server.registerTool(
    'cyggie_get_meeting',
    {
      description:
        'Fetch one meeting by id. Returns the full meeting block: title, ' +
        'date, participants, notes, AI summary, and (optionally) the ' +
        'transcript. Set includeTranscript=false to skip the transcript ' +
        'and save tokens when the summary is enough.',
      inputSchema: {
        id: z.string().min(1).describe('Meeting cuid2 id.'),
        includeTranscript: z
          .boolean()
          .optional()
          .describe('Include transcript in output (default true).'),
      },
    },
    async (input) =>
      run('cyggie_get_meeting', () =>
        cyggieGetMeeting({
          db: ctx.db,
          userId: ctx.userId,
          id: input.id,
          includeTranscript: input.includeTranscript,
        }),
      ),
  )

  // cyggie_get_notes ───────────────────────────────────────────────────
  server.registerTool(
    'cyggie_get_notes',
    {
      description:
        'List notes attached to a company / contact / meeting, or matching ' +
        'a full-text query. Requires at least one filter argument — calling ' +
        'with no args returns INVALID_INPUT. Pinned notes appear first, ' +
        'then most-recently-updated. Pass includeFullContent=true to get ' +
        'each note in full rather than as a preview.',
      inputSchema: {
        companyId: z.string().optional().describe('Filter to notes on this company.'),
        contactId: z.string().optional().describe('Filter to notes on this contact.'),
        meetingId: z.string().optional().describe('Filter to notes from this meeting.'),
        query: z
          .string()
          .optional()
          .describe('Full-text search across title + content.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max notes to return (default 10, max 25).'),
        includeFullContent: z
          .boolean()
          .optional()
          .describe('Return full content of each note (default false = preview).'),
      },
    },
    async (input) =>
      run('cyggie_get_notes', () =>
        cyggieGetNotes({
          db: ctx.db,
          userId: ctx.userId,
          companyId: input.companyId,
          contactId: input.contactId,
          meetingId: input.meetingId,
          query: input.query,
          limit: input.limit,
          includeFullContent: input.includeFullContent,
        }),
      ),
  )

  // cyggie_execute_sql ─────────────────────────────────────────────────
  // Highest-privilege tool: requires both the env feature flag
  // (CYGGIE_MCP_SQL_ENABLED=true) AND the caller's OAuth token
  // carrying `cyggie:sql` scope. Registered only when both conditions
  // are met so the tool simply doesn't appear in tools/list otherwise —
  // safest default for clients that probe the catalog.
  if (ctx.env.CYGGIE_MCP_SQL_ENABLED) {
    server.registerTool(
      'cyggie_execute_sql',
      {
        description:
          'Run a read-only SELECT or WITH query against the Cyggie CRM ' +
          'database. Use this only when the structured tools cannot ' +
          'express what the user asked (e.g. "top 10 companies by ' +
          'funding raised in the last 12 months", "count contacts per ' +
          'pipeline stage"). Requires the cyggie:sql OAuth scope. ' +
          'Allowed tables: org_companies, org_company_aliases, ' +
          'org_company_contacts, company_investors, contacts, ' +
          'contact_emails, meetings, meeting_company_links, ' +
          'meeting_speaker_contact_links, notes, themes, note_folders, ' +
          'company_flagged_files, custom_field_defs, custom_field_values, ' +
          'deals, tasks. Query must start with SELECT or WITH and ' +
          'cannot contain `;` (multi-statement). Statement timeout ' +
          '5s; output capped at 1000 rows.',
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(8_000)
            .describe('A single SELECT or WITH query (no `;` separators).'),
        },
      },
      async (input) =>
        runWithScope(
          'cyggie_execute_sql',
          'cyggie:sql',
          () =>
            cyggieExecuteSql({
              env: ctx.env,
              query: input.query,
              log: ctx.log,
            }),
        ),
    )
  }

  return server

  // Scope-gated runner: returns PERMISSION_DENIED envelope when the
  // caller's token lacks the required scope. Inline here (rather than
  // factored out) so it closes over the same ctx + run() that the
  // other tools use.
  async function runWithScope(
    name: string,
    requiredScope: string,
    handler: () => Promise<ToolResult>,
  ): Promise<CallToolResult> {
    if (!ctx.scopes.includes(requiredScope)) {
      ctx.log.warn(
        {
          metric: 'mcp.tool.errors',
          tool: name,
          error_code: 'PERMISSION_DENIED',
          userId: ctx.userId,
        },
        `mcp tool blocked — token lacks ${requiredScope}`,
      )
      return toolResultToCallToolResult(
        err(
          ERROR_CODE.PERMISSION_DENIED,
          `Tool requires the ${requiredScope} OAuth scope.`,
        ),
      )
    }
    return run(name, handler)
  }
}

// Wraps a tool handler call with the per-tool observability boilerplate:
//   - Sentry breadcrumb on entry
//   - duration timing
//   - structured metric log line (success or error)
//   - converts thrown errors into INTERNAL CallToolResult so MCP never
//     5xx's mid-stream
//   - bridges the internal ToolResult envelope to the MCP wire format
//
// Returning a closure keeps each registerTool call short while
// guaranteeing every tool emits the same metrics. The thrown-error
// branch is the load-bearing one — without it, a tool that throws
// (DB connection lost, JSON.stringify on circular ref) would bubble
// up as a generic 500 with no Sentry tag.
function makeRunner(ctx: BuildMcpServerArgs) {
  return async function run(
    name: string,
    handler: () => Promise<ToolResult>,
  ): Promise<CallToolResult> {
    const startedAt = Date.now()
    Sentry.addBreadcrumb({
      category: 'mcp-tool',
      level: 'info',
      message: `mcp.tool.invoked: ${name}`,
      data: { tool: name, userId: ctx.userId },
    })
    try {
      const result = await handler()
      const duration_ms = Date.now() - startedAt
      const bridged = toolResultToCallToolResult(result)
      if (bridged.isError) {
        ctx.log.warn(
          {
            metric: 'mcp.tool.errors',
            tool: name,
            error_code: bridged._meta?.['code'],
            duration_ms,
            userId: ctx.userId,
          },
          'mcp tool returned error envelope',
        )
      } else {
        ctx.log.info(
          {
            metric: 'mcp.tool.invocations',
            tool: name,
            ok: true,
            duration_ms,
            userId: ctx.userId,
          },
          'mcp tool ok',
        )
      }
      return bridged
    } catch (err) {
      const duration_ms = Date.now() - startedAt
      ctx.log.error(
        {
          err,
          metric: 'mcp.tool.errors',
          tool: name,
          error_code: 'INTERNAL',
          duration_ms,
          userId: ctx.userId,
        },
        'mcp tool threw',
      )
      Sentry.captureException(err, {
        tags: { code: 'INTERNAL', mcp_tool: name },
        user: { id: ctx.userId },
      })
      return {
        content: [
          { type: 'text', text: '[INTERNAL] Unexpected tool error. See server logs.' },
        ],
        isError: true,
        _meta: { code: 'INTERNAL' },
      }
    }
  }
}
