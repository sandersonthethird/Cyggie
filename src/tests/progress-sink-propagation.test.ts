/**
 * Phase 0.5 Batch 1 contract test — verifies the AsyncLocalStorage-based
 * ProgressSink (packages/services/src/llm/send-progress.ts) correctly
 * propagates across the async boundaries the LLM tree relies on.
 *
 * If this test fails on a real Anthropic SDK upgrade, the fallback per
 * plan-eng-review §1.4 is to thread an explicit ProgressSink parameter
 * through the affected call site.
 */

import { describe, expect, it } from 'vitest'
import {
  currentProgressSink,
  sendClear,
  sendPhase,
  sendProgress,
  withProgressSink,
} from '@cyggie/services/llm/send-progress'
import type { ProgressSink } from '@cyggie/services/llm/send-progress'

function makeRecordingSink(): ProgressSink & {
  chunks: string[]
  clears: number
  phases: string[]
} {
  const chunks: string[] = []
  const phases: string[] = []
  let clears = 0
  return {
    chunks,
    phases,
    get clears() {
      return clears
    },
    onChunk: (text) => chunks.push(text),
    onClear: () => {
      clears++
    },
    onPhase: (phase) => phases.push(phase),
  }
}

describe('progress-sink-propagation', () => {
  it('routes sendProgress / sendClear / sendPhase to the active sink', async () => {
    const sink = makeRecordingSink()
    await withProgressSink(sink, async () => {
      sendProgress('hello')
      sendProgress(' world')
      sendPhase('drafting')
      sendClear()
    })
    expect(sink.chunks).toEqual(['hello', ' world'])
    expect(sink.phases).toEqual(['drafting'])
    expect(sink.clears).toBe(1)
  })

  it('returns undefined when no sink is in scope (silent no-op)', () => {
    // These should not throw even with no ALS context.
    sendProgress('orphaned')
    sendClear()
    sendPhase('orphaned')
    expect(currentProgressSink()).toBeUndefined()
  })

  it('survives microtask boundaries (await + Promise.then)', async () => {
    const sink = makeRecordingSink()
    await withProgressSink(sink, async () => {
      sendProgress('before await')
      await Promise.resolve()
      sendProgress('after microtask')
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          sendProgress('after macrotask')
          resolve()
        }, 5)
      })
      sendProgress('after macrotask await')
    })
    expect(sink.chunks).toEqual([
      'before await',
      'after microtask',
      'after macrotask',
      'after macrotask await',
    ])
  })

  it('survives nested async function calls', async () => {
    const sink = makeRecordingSink()

    async function deepCall(): Promise<void> {
      await Promise.resolve()
      sendProgress('from deepCall')
    }

    async function intermediate(): Promise<void> {
      sendProgress('from intermediate (before deepCall)')
      await deepCall()
      sendProgress('from intermediate (after deepCall)')
    }

    await withProgressSink(sink, async () => {
      sendProgress('from outer')
      await intermediate()
      sendProgress('back in outer')
    })

    expect(sink.chunks).toEqual([
      'from outer',
      'from intermediate (before deepCall)',
      'from deepCall',
      'from intermediate (after deepCall)',
      'back in outer',
    ])
  })

  it('survives Promise.all parallel branches with the SAME sink', async () => {
    const sink = makeRecordingSink()
    await withProgressSink(sink, async () => {
      await Promise.all([
        (async () => {
          await Promise.resolve()
          sendProgress('branch-A')
        })(),
        (async () => {
          await Promise.resolve()
          sendProgress('branch-B')
        })(),
      ])
    })
    // Order isn't guaranteed across parallel branches but both should land.
    expect(sink.chunks).toHaveLength(2)
    expect(sink.chunks).toContain('branch-A')
    expect(sink.chunks).toContain('branch-B')
  })

  it('nested withProgressSink shadows the outer sink for its scope', async () => {
    const outer = makeRecordingSink()
    const inner = makeRecordingSink()
    await withProgressSink(outer, async () => {
      sendProgress('outer-only')
      await withProgressSink(inner, async () => {
        sendProgress('inner-only')
      })
      sendProgress('outer-again')
    })
    expect(outer.chunks).toEqual(['outer-only', 'outer-again'])
    expect(inner.chunks).toEqual(['inner-only'])
  })

  it('isolates concurrent withProgressSink invocations (independent ALS contexts)', async () => {
    const sinkA = makeRecordingSink()
    const sinkB = makeRecordingSink()

    async function runWithSink(sink: ProgressSink, label: string): Promise<void> {
      await withProgressSink(sink, async () => {
        sendProgress(`${label}-1`)
        await Promise.resolve()
        sendProgress(`${label}-2`)
      })
    }

    await Promise.all([runWithSink(sinkA, 'A'), runWithSink(sinkB, 'B')])

    expect(sinkA.chunks).toEqual(['A-1', 'A-2'])
    expect(sinkB.chunks).toEqual(['B-1', 'B-2'])
  })

  it('optional onClear/onPhase are no-ops when sink omits them', async () => {
    const minimal: ProgressSink = {
      chunks: [],
      onChunk(text: string) {
        // @ts-expect-error — minimal sink for the contract test
        this.chunks.push(text)
      },
    } as ProgressSink & { chunks: string[] }
    await withProgressSink(minimal, async () => {
      sendProgress('one')
      sendClear() // should not throw
      sendPhase('phase') // should not throw
    })
    // @ts-expect-error — see above
    expect(minimal.chunks).toEqual(['one'])
  })
})
