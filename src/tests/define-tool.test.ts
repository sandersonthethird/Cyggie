import { describe, it, expect, vi } from 'vitest'
import { defineTool, buildToolRegistry, findTerminalTool, zodToJsonSchema, z } from '../main/llm/agents/define-tool'

const ctx = {
  companyId: 'co-1',
  userId: 'u-1',
  runId: 'r-1',
  signal: new AbortController().signal,
}

describe('defineTool — input validation', () => {
  it('parses valid input and returns handler output', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echoes',
      input: z.object({ msg: z.string() }),
      handler: ({ msg }) => ({ echo: msg }),
    })
    const result = await tool.dispatch({ msg: 'hi' }, ctx)
    expect(result.output).toEqual({ echo: 'hi' })
    expect(result.errorClass).toBeUndefined()
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('returns error envelope when Zod parse fails', async () => {
    const tool = defineTool({
      name: 'strict',
      description: 'requires meetingId',
      input: z.object({ meetingId: z.string() }),
      handler: ({ meetingId }) => ({ id: meetingId }),
    })
    const result = await tool.dispatch({ wrongKey: 'x' }, ctx)
    expect(result.errorClass).toBe('ZodError')
    expect(result.output).toMatchObject({ error: expect.stringContaining('invalid_input') })
  })

  it('wraps handler exceptions in error envelope (does not throw)', async () => {
    const tool = defineTool({
      name: 'crashy',
      description: 'crashes',
      input: z.object({}),
      handler: () => { throw new Error('boom') },
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.errorClass).toBe('Error')
    expect(result.output).toMatchObject({ error: expect.stringContaining('boom') })
  })

  it('wraps async handler rejections', async () => {
    const tool = defineTool({
      name: 'crashy-async',
      description: '',
      input: z.object({}),
      handler: async () => { throw new TypeError('nope') },
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.errorClass).toBe('TypeError')
  })

  it('records ms duration', async () => {
    const tool = defineTool({
      name: 'slow',
      description: '',
      input: z.object({}),
      handler: async () => {
        await new Promise(r => setTimeout(r, 10))
        return { ok: true }
      },
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.ms).toBeGreaterThanOrEqual(10)
  })
})

describe('defineTool — output truncation', () => {
  it('truncates string output exceeding outputMaxChars', async () => {
    const tool = defineTool({
      name: 'big-string',
      description: '',
      input: z.object({}),
      output: { maxChars: 100 },
      handler: () => 'x'.repeat(500),
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.truncated).toBe(true)
    expect(typeof result.output).toBe('string')
    expect((result.output as string).length).toBeLessThan(150)
    expect((result.output as string)).toContain('truncated')
  })

  it('marks object outputs as truncated when serialized exceeds limit', async () => {
    const tool = defineTool({
      name: 'big-object',
      description: '',
      input: z.object({}),
      output: { maxChars: 100 },
      handler: () => ({ items: 'y'.repeat(500) }),
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.truncated).toBe(true)
    // Object preserved (handler's job to truncate inside if needed)
    expect(typeof result.output).toBe('object')
  })

  it('does not flag truncated when output fits', async () => {
    const tool = defineTool({
      name: 'small',
      description: '',
      input: z.object({}),
      output: { maxChars: 1000 },
      handler: () => 'short',
    })
    const result = await tool.dispatch({}, ctx)
    expect(result.truncated).toBe(false)
  })
})

describe('defineTool — terminal flag', () => {
  it('defaults terminal to false', () => {
    const tool = defineTool({ name: 'a', description: '', input: z.object({}), handler: () => ({}) })
    expect(tool.terminal).toBe(false)
    expect(tool.category).toBe('internal_read')
  })

  it('marks terminal=true and category=terminal when specified', () => {
    const tool = defineTool({
      name: 'submit_memo',
      description: '',
      input: z.object({ markdown: z.string() }),
      terminal: true,
      handler: () => ({ ok: true }),
    })
    expect(tool.terminal).toBe(true)
    expect(tool.category).toBe('terminal')
  })
})

describe('buildToolRegistry / findTerminalTool', () => {
  it('throws on duplicate tool names', () => {
    const a = defineTool({ name: 'x', description: '', input: z.object({}), handler: () => ({}) })
    const b = defineTool({ name: 'x', description: '', input: z.object({}), handler: () => ({}) })
    expect(() => buildToolRegistry([a, b])).toThrow(/duplicate tool name: x/)
  })

  it('finds the single terminal tool', () => {
    const a = defineTool({ name: 'a', description: '', input: z.object({}), handler: () => ({}) })
    const b = defineTool({ name: 'submit', description: '', input: z.object({}), terminal: true, handler: () => ({}) })
    expect(findTerminalTool([a, b])).toBe(b)
  })

  it('throws when zero terminal tools defined', () => {
    const a = defineTool({ name: 'a', description: '', input: z.object({}), handler: () => ({}) })
    expect(() => findTerminalTool([a])).toThrow(/no terminal tool/)
  })

  it('throws when multiple terminal tools', () => {
    const a = defineTool({ name: 'a', description: '', input: z.object({}), terminal: true, handler: () => ({}) })
    const b = defineTool({ name: 'b', description: '', input: z.object({}), terminal: true, handler: () => ({}) })
    expect(() => findTerminalTool([a, b])).toThrow(/multiple terminal tools/)
  })
})

describe('zodToJsonSchema', () => {
  it('converts a basic object schema with required/optional fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
      active: z.boolean(),
    })
    const json = zodToJsonSchema(schema) as {
      type: string
      properties: Record<string, { type: string }>
      required: string[]
      additionalProperties: boolean
    }
    expect(json.type).toBe('object')
    expect(json.properties.name.type).toBe('string')
    expect(json.properties.age.type).toBe('number')
    expect(json.properties.active.type).toBe('boolean')
    expect(json.required.sort()).toEqual(['active', 'name'])
    expect(json.additionalProperties).toBe(false)
  })

  it('converts arrays and enums', () => {
    const schema = z.object({
      tags: z.array(z.string()),
      role: z.enum(['admin', 'user']),
    })
    const json = zodToJsonSchema(schema) as { properties: { tags: { type: string; items: { type: string } }; role: { type: string; enum: string[] } } }
    expect(json.properties.tags.type).toBe('array')
    expect(json.properties.tags.items.type).toBe('string')
    expect(json.properties.role.enum).toEqual(['admin', 'user'])
  })

  it('handles nullable types', () => {
    const schema = z.object({ id: z.string().nullable() })
    const json = zodToJsonSchema(schema) as { properties: { id: { type: string[] } } }
    expect(json.properties.id.type).toContain('null')
    expect(json.properties.id.type).toContain('string')
  })
})

describe('toAnthropicTool', () => {
  it('produces { name, description, input_schema } shape', () => {
    const tool = defineTool({
      name: 'list_meetings',
      description: 'List meetings for the company',
      input: z.object({ limit: z.number().optional() }),
      handler: () => [],
    })
    const t = tool.toAnthropicTool()
    expect(t.name).toBe('list_meetings')
    expect(t.description).toBe('List meetings for the company')
    expect(t.input_schema).toBeDefined()
  })
})
