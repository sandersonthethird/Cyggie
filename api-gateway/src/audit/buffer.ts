// Async fire-and-forget audit buffer (External Agents V1 slice 7,
// decision-log #27).
//
// Tool responses should never wait on the audit-row INSERT. We
// in-memory-buffer audit rows and flush them on a timer or size
// threshold or graceful shutdown. On gateway crash we lose at most
// FLUSH_INTERVAL_MS of audit data — acceptable for V1.
//
// Backpressure: once the buffer holds BACKPRESSURE_LIMIT rows
// (writers outpacing flushes), we Sentry-alert and switch to
// synchronous writes so memory doesn't grow unbounded. The buffer
// returns to async mode once it drains below the limit.
//
// Singleton per gateway process. Tests can create dedicated
// AuditBuffer instances for assertions.

import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import type { FastifyBaseLogger } from 'fastify'
import { Sentry } from '../sentry'
import type { getDb } from '../db'

export interface McpAuditRow {
  surface: 'slack' | 'mcp'
  toolName: string
  firmId?: string | null
  onBehalfOfUserId?: string | null
  onBehalfOfSlackId?: string | null
  slackMessageTs?: string | null
  inputSummary?: string | null
  outputSize?: number | null
  durationMs?: number | null
  ok: boolean
  errorCode?: string | null
  extras?: Record<string, unknown> | null
}

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_SIZE_THRESHOLD = 100
const BACKPRESSURE_LIMIT = 1_000

export interface AuditBufferOptions {
  db: ReturnType<typeof getDb>
  log?: FastifyBaseLogger
  flushIntervalMs?: number
  flushSizeThreshold?: number
  backpressureLimit?: number
}

export class AuditBuffer {
  private readonly db: ReturnType<typeof getDb>
  private readonly log?: FastifyBaseLogger
  private readonly flushIntervalMs: number
  private readonly flushSizeThreshold: number
  private readonly backpressureLimit: number
  private buffer: Array<typeof schema.mcpAudit.$inferInsert> = []
  private timer: NodeJS.Timeout | null = null
  private backpressureAlerted = false
  private flushing: Promise<void> | null = null
  private stopped = false

  constructor(opts: AuditBufferOptions) {
    this.db = opts.db
    this.log = opts.log
    this.flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS
    this.flushSizeThreshold = opts.flushSizeThreshold ?? FLUSH_SIZE_THRESHOLD
    this.backpressureLimit = opts.backpressureLimit ?? BACKPRESSURE_LIMIT
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.log?.error({ err }, 'audit buffer: flush tick failed')
      })
    }, this.flushIntervalMs)
    // Don't keep the event loop alive just for the audit timer.
    this.timer.unref?.()
  }

  /**
   * Enqueue an audit row. Returns immediately unless the buffer is
   * over the backpressure limit, in which case it awaits a synchronous
   * write to apply backpressure to the caller.
   */
  async record(row: McpAuditRow): Promise<void> {
    if (this.stopped) {
      // Don't accept new rows after shutdown — write synchronously so
      // we don't drop the audit silently.
      await this.writeRows([toInsert(row)])
      return
    }

    if (this.buffer.length >= this.backpressureLimit) {
      if (!this.backpressureAlerted) {
        this.backpressureAlerted = true
        this.log?.error(
          {
            metric: 'audit.buffer.overflow',
            buffered: this.buffer.length,
            limit: this.backpressureLimit,
          },
          'audit buffer over backpressure limit; switching to sync writes',
        )
        Sentry.captureMessage('Audit buffer backpressure exceeded', {
          tags: { surface: 'audit_buffer', metric: 'audit.buffer.overflow' },
          level: 'warning',
          extra: { buffered: this.buffer.length, limit: this.backpressureLimit },
        })
      }
      // Synchronous write — applies backpressure to caller.
      await this.writeRows([toInsert(row)])
      return
    }

    this.buffer.push(toInsert(row))

    if (this.buffer.length >= this.flushSizeThreshold) {
      // Don't await — fire-and-forget per spec.
      this.flush().catch((err) => {
        this.log?.error({ err }, 'audit buffer: size-triggered flush failed')
      })
    }
  }

  /**
   * Flush all buffered rows. Safe to call concurrently — overlapping
   * calls coalesce.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing
      return
    }
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    this.flushing = this.writeRows(batch)
      .catch((err) => {
        this.log?.error(
          { err, rowCount: batch.length },
          'audit buffer: write failed; rows lost',
        )
        Sentry.captureException(err, {
          tags: { surface: 'audit_buffer' },
          extra: { rowCount: batch.length },
        })
      })
      .finally(() => {
        this.flushing = null
        // Clear the backpressure alert once we drain back below the
        // threshold — next overflow re-alerts.
        if (this.backpressureAlerted && this.buffer.length < this.backpressureLimit / 2) {
          this.backpressureAlerted = false
        }
      })
    await this.flushing
  }

  /**
   * Graceful shutdown: stop the timer, flush remaining rows
   * synchronously, then mark stopped.
   */
  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  // Visible for testing — number of rows currently buffered.
  size(): number {
    return this.buffer.length
  }

  private async writeRows(
    rows: Array<typeof schema.mcpAudit.$inferInsert>,
  ): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(schema.mcpAudit).values(rows)
  }
}

function toInsert(row: McpAuditRow): typeof schema.mcpAudit.$inferInsert {
  return {
    id: createId(),
    surface: row.surface,
    toolName: row.toolName,
    firmId: row.firmId ?? null,
    onBehalfOfUserId: row.onBehalfOfUserId ?? null,
    onBehalfOfSlackId: row.onBehalfOfSlackId ?? null,
    slackMessageTs: row.slackMessageTs ?? null,
    inputSummary: row.inputSummary ?? null,
    outputSize: row.outputSize ?? null,
    durationMs: row.durationMs ?? null,
    ok: row.ok,
    errorCode: row.errorCode ?? null,
    extras: row.extras ?? null,
  }
}

// ─── Singleton (gateway process) ─────────────────────────────────────

let singleton: AuditBuffer | null = null

export function initAuditBuffer(opts: AuditBufferOptions): AuditBuffer {
  if (singleton) return singleton
  singleton = new AuditBuffer(opts)
  singleton.start()
  return singleton
}

export function getAuditBuffer(): AuditBuffer | null {
  return singleton
}

/**
 * Convenience: record an audit row through the singleton. No-op if
 * the buffer hasn't been initialized (e.g. in test environments that
 * skip server bootstrap).
 */
export function recordAuditAsync(row: McpAuditRow): void {
  const buf = singleton
  if (!buf) return
  buf.record(row).catch(() => {
    // Already logged inside the buffer; swallow here so callers stay
    // fire-and-forget.
  })
}

// Visible for tests — reset the singleton between cases.
export function _resetAuditBufferForTests(): void {
  singleton = null
}
