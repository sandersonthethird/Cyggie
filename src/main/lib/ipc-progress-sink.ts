import { BrowserWindow } from 'electron'
import type { ProgressSink } from '@cyggie/services/llm/send-progress'
import type { IpcChannel } from '@shared/constants/channels'
import { IPC_CHANNELS } from '@shared/constants/channels'

// Desktop-side ProgressSink factory: routes onChunk / onClear / onPhase to
// `BrowserWindow.getAllWindows().webContents.send(channel, ...)`. Wraps the
// pre-Phase-0.5 hand-rolled broadcast logic so the extracted LLM tree in
// packages/services/llm/ can stream into the renderer unchanged from the
// renderer's perspective.
//
// Caller pattern (in any IPC handler that invokes chat-runner / summarizer):
//
//   import { withProgressSink } from '@cyggie/services/llm/send-progress'
//   import { createIpcProgressSink } from '@main/lib/ipc-progress-sink'
//
//   await withProgressSink(
//     createIpcProgressSink({
//       chunkChannel: IPC_CHANNELS.SUMMARY_PROGRESS,
//       phaseChannel: IPC_CHANNELS.SUMMARY_PHASE,
//     }),
//     () => generateSummary(meetingId, templateId, userId),
//   )
//
// Two channel inputs because chat vs summary use different renderer-side event
// names; pass whichever pair the route needs.

export interface IpcSinkOpts {
  /** Channel for `onChunk` events (streamed text). */
  chunkChannel: IpcChannel
  /** Channel for `onPhase` events (coarse-grained labels). Optional. */
  phaseChannel?: IpcChannel
  /**
   * If true, `onClear()` broadcasts `null` on `chunkChannel`. Renderer code
   * already treats `null` as "clear the streaming UI". Default true.
   */
  clearAsNullOnChunk?: boolean
}

export function createIpcProgressSink(opts: IpcSinkOpts): ProgressSink {
  const broadcast = (channel: IpcChannel, payload: string | null): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }
  const clearAsNull = opts.clearAsNullOnChunk ?? true

  return {
    onChunk(text) {
      broadcast(opts.chunkChannel, text)
    },
    onClear() {
      if (clearAsNull) broadcast(opts.chunkChannel, null)
    },
    onPhase(phase) {
      if (opts.phaseChannel) broadcast(opts.phaseChannel, phase)
    },
  }
}

// Preset sinks for the two existing channel pairs in the app.

export function createChatProgressSink(): ProgressSink {
  return createIpcProgressSink({
    chunkChannel: IPC_CHANNELS.CHAT_PROGRESS,
  })
}

export function createSummaryProgressSink(): ProgressSink {
  return createIpcProgressSink({
    chunkChannel: IPC_CHANNELS.SUMMARY_PROGRESS,
    phaseChannel: IPC_CHANNELS.SUMMARY_PHASE,
  })
}
