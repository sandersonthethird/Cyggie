import { z, ZodError, ZodType } from 'zod'

/**
 * Tool factory and registry primitives for the agent loop.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  defineTool({ name, description, input, output, handler })     │
 *   │                                                                 │
 *   │  Returns a Tool object that the agent loop can:                 │
 *   │    1. expose to Anthropic via the `tools` request param         │
 *   │       (uses zod-to-JSON-schema for input_schema)                │
 *   │    2. dispatch when the model emits a tool_use block            │
 *   │       (parses input via Zod, runs handler, truncates output,    │
 *   │       emits timing, wraps errors in {error} envelope)            │
 *   │                                                                 │
 *   │  Cross-cutting concerns (Zod validation, output truncation,     │
 *   │  timing wrapper, error envelope) are implemented ONCE here,     │
 *   │  not duplicated across each tool's handler. Per-tool spec is    │
 *   │  ~8 lines.                                                       │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Terminal tools: a tool with `terminal: true` causes the agent loop to stop
 * after its first invocation. The thesis stress-test agent's `submit_memo`
 * is the only terminal tool today. The loop reads its already-validated input
 * as the structured run output.
 */

export interface ToolContext {
  companyId: string
  userId: string
  runId: string
  signal: AbortSignal
}

export interface ToolDispatchResult {
  /** JSON-serializable output, possibly truncated. */
  output: unknown
  /** True if output was string-truncated to fit outputMaxChars. */
  truncated: boolean
  /** String size in bytes; useful for observability + context-budget tracking. */
  bytes: number
  /** Wall-clock duration of the handler call. */
  ms: number
  /** Set when Zod parse failed or the handler threw. The output is then the error envelope. */
  errorClass?: string
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<I>
  readonly outputMaxChars: number
  readonly terminal: boolean
  readonly category: ToolCategory
  /** The original handler (untrusted input) — kept for tests; the loop calls dispatch(). */
  readonly handler: (input: I, ctx: ToolContext) => Promise<O> | O
  /** The wrapped dispatch the agent loop uses. Validates, runs, truncates, times. */
  dispatch(rawInput: unknown, ctx: ToolContext): Promise<ToolDispatchResult>
  /** Zod-derived JSON Schema for the Anthropic `tools` parameter. */
  toAnthropicTool(): { name: string; description: string; input_schema: object }
}

export type ToolCategory = 'internal_read' | 'web' | 'terminal'

export interface ToolSpec<I, O> {
  name: string
  description: string
  input: ZodType<I>
  output?: { maxChars?: number }
  /** When true, the agent loop terminates after the first call to this tool. */
  terminal?: boolean
  category?: ToolCategory
  handler: (input: I, ctx: ToolContext) => Promise<O> | O
}

const DEFAULT_OUTPUT_MAX_CHARS = 4_000

export function defineTool<I, O>(spec: ToolSpec<I, O>): Tool<I, O> {
  const outputMaxChars = spec.output?.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS
  const terminal = spec.terminal ?? false
  const category = spec.category ?? (terminal ? 'terminal' : 'internal_read')

  const tool: Tool<I, O> = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input,
    outputMaxChars,
    terminal,
    category,
    handler: spec.handler,

    async dispatch(rawInput: unknown, ctx: ToolContext): Promise<ToolDispatchResult> {
      const startedAt = Date.now()

      // 1. Validate input via Zod.
      let input: I
      try {
        input = spec.input.parse(rawInput)
      } catch (err) {
        const message = err instanceof ZodError ? formatZodIssues(err) : String(err)
        const envelope = { error: `invalid_input: ${message}` }
        return finalize(envelope, true, 'ZodError', startedAt)
      }

      // 2. Run the handler. Catch synchronous throws AND async rejections.
      let raw: O
      try {
        raw = await spec.handler(input, ctx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const errorClass = err instanceof Error ? err.name : 'Error'
        const envelope = { error: `tool_failed: ${message}` }
        return finalize(envelope, false, errorClass, startedAt)
      }

      // 3. Truncate string output to fit. Object outputs are stringified once
      //    to measure size; if oversized, we keep the object but mark truncated
      //    so the loop knows context grew. (Most tools return objects; only
      //    web_fetch / read_meeting_transcript return raw text, and those
      //    truncate inside the handler too.)
      return finalize(raw, false, undefined, startedAt, outputMaxChars)
    },

    toAnthropicTool() {
      return {
        name: spec.name,
        description: spec.description,
        input_schema: zodToJsonSchema(spec.input),
      }
    },
  }

  return tool
}

function finalize(
  output: unknown,
  truncated: boolean,
  errorClass: string | undefined,
  startedAt: number,
  maxChars?: number,
): ToolDispatchResult {
  let serialized: string
  try {
    serialized = typeof output === 'string' ? output : JSON.stringify(output)
  } catch {
    serialized = '[unserializable]'
  }
  let finalOutput = output
  let isTrunc = truncated
  if (maxChars && serialized.length > maxChars) {
    if (typeof output === 'string') {
      finalOutput = output.slice(0, maxChars) + '\n\n[…truncated]'
    }
    // Mark truncated for both string and object cases. Object handlers are
    // expected to truncate internally; this flag surfaces "didn't fit" to
    // observability so the loop and telemetry see the size.
    isTrunc = true
  }
  return {
    output: finalOutput,
    truncated: isTrunc,
    bytes: serialized.length,
    ms: Date.now() - startedAt,
    errorClass,
  }
}

function formatZodIssues(err: ZodError): string {
  const issues = err.issues.slice(0, 3).map(i => {
    const path = i.path.length ? i.path.join('.') : '<root>'
    return `${path}: ${i.message}`
  })
  return issues.join('; ')
}

/**
 * Minimal Zod → JSON Schema converter for Anthropic's tools input_schema.
 * Zod doesn't natively emit JSON Schema and we'd rather not pull in
 * zod-to-json-schema for this small surface. Supported: object (with nested
 * object/string/number/boolean/array/enum/literal/optional/nullable/default/
 * union). Unsupported types fall back to permissive `{}` (Anthropic accepts;
 * Zod still re-validates strictly on dispatch, so the runtime guarantee holds).
 *
 * Targets Zod 4's internal shape: schemas expose `_def` (alias `def`) with
 * `type: 'object' | 'string' | ...` and shape as a direct object literal
 * (not a function as in Zod 3). Object children are Zod schemas; recurse
 * through their `_def`.
 */
export function zodToJsonSchema(schema: ZodType): object {
  return convert(schema as unknown as { _def?: ZodInternalDef; def?: ZodInternalDef })

  function convert(s: { _def?: ZodInternalDef; def?: ZodInternalDef } | undefined): object {
    if (!s) return {}
    const d: ZodInternalDef | undefined = s._def ?? s.def
    if (!d) return {}
    const tn = d.type
    switch (tn) {
      case 'object': {
        const shape = (d.shape ?? {}) as Record<string, { _def?: ZodInternalDef; def?: ZodInternalDef }>
        const properties: Record<string, object> = {}
        const required: string[] = []
        for (const key of Object.keys(shape)) {
          const inner = shape[key]
          properties[key] = convert(inner)
          if (!isOptional(inner)) required.push(key)
        }
        const out: Record<string, unknown> = { type: 'object', properties }
        if (required.length) out.required = required
        out.additionalProperties = false
        return out
      }
      case 'string':   return { type: 'string' }
      case 'number':   return { type: 'number' }
      case 'boolean':  return { type: 'boolean' }
      case 'array':    return { type: 'array', items: convert(d.element as { _def?: ZodInternalDef }) }
      case 'enum': {
        // Zod 4 stores enum values either as `values` (array) or as `entries` (Record<value, value>).
        const values = Array.isArray(d.values)
          ? d.values
          : d.entries
            ? Object.values(d.entries)
            : []
        return { type: 'string', enum: values }
      }
      case 'literal':  return { const: d.value }
      case 'optional': return convert(d.innerType as { _def?: ZodInternalDef })
      case 'default':  return convert(d.innerType as { _def?: ZodInternalDef })
      case 'nullable': {
        const inner = convert(d.innerType as { _def?: ZodInternalDef }) as { type?: string | string[] }
        if (inner.type) {
          inner.type = Array.isArray(inner.type) ? [...inner.type, 'null'] : [inner.type, 'null']
        }
        return inner
      }
      case 'pipe':     return convert((d.in ?? d.innerType) as { _def?: ZodInternalDef })
      case 'union':
        return { oneOf: ((d.options ?? []) as Array<{ _def?: ZodInternalDef }>).map(o => convert(o)) }
      default:         return {}
    }
  }

  function isOptional(s: { _def?: ZodInternalDef; def?: ZodInternalDef } | undefined): boolean {
    if (!s) return false
    const d = s._def ?? s.def
    if (!d) return false
    return d.type === 'optional' || d.type === 'default'
  }
}

interface ZodInternalDef {
  type: string
  shape?: unknown
  innerType?: unknown
  element?: unknown
  values?: unknown[]
  entries?: Record<string, unknown>
  value?: unknown
  options?: unknown[]
  in?: unknown
}

/**
 * Convenience: build a registry from a list of tools, indexed by name.
 * Throws on duplicate names.
 */
export function buildToolRegistry(tools: Tool[]): Map<string, Tool> {
  const registry = new Map<string, Tool>()
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`)
    }
    registry.set(tool.name, tool)
  }
  return registry
}

/**
 * Find the terminal tool in a list. Throws if zero or more than one is
 * marked terminal — the agent loop needs exactly one stop condition.
 */
export function findTerminalTool(tools: Tool[]): Tool {
  const terminals = tools.filter(t => t.terminal)
  if (terminals.length === 0) throw new Error('no terminal tool defined')
  if (terminals.length > 1) {
    throw new Error(`multiple terminal tools: ${terminals.map(t => t.name).join(', ')}`)
  }
  return terminals[0]
}

// Re-export Zod's `z` so callers don't need a separate import.
export { z }
