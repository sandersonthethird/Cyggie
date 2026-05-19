import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { SyncAgent } from '../services/sync-agent'

// =============================================================================
// sync.ipc.ts — IPC handlers exposing SyncAgent state to the renderer.
//
// Three channels:
//   • SYNC_STATUS              → snapshot the agent's current state for the
//                                 tray icon / settings panel.
//   • SYNC_FORCE_FLUSH         → trigger an immediate drain (admin button).
//   • SYNC_RETRY_DEAD_LETTERS  → reset status='dead' rows to 'pending' for
//                                 another go-around.
//
// Registered by the desktop main process during bootstrap; sync-agent.ts
// holds the singleton SyncAgent instance.
// =============================================================================

let agent: SyncAgent | null = null

/**
 * Wire IPC handlers to a SyncAgent instance. Call once during desktop
 * main process bootstrap after the agent is constructed.
 */
export function registerSyncIpc(syncAgent: SyncAgent): void {
  agent = syncAgent

  ipcMain.handle(IPC_CHANNELS.SYNC_STATUS, () => {
    return agent?.snapshot() ?? null
  })

  ipcMain.handle(IPC_CHANNELS.SYNC_FORCE_FLUSH, () => {
    agent?.triggerFlush()
    return agent?.snapshot() ?? null
  })

  ipcMain.handle(IPC_CHANNELS.SYNC_RETRY_DEAD_LETTERS, () => {
    const promoted = agent?.retryDeadLetters() ?? 0
    return { promoted, snapshot: agent?.snapshot() ?? null }
  })
}
