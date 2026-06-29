import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

export interface SharedStorageStatus {
  paused: boolean
  queueDepth: number
  message: string | null
}

const IDLE: SharedStorageStatus = { paused: false, queueDepth: 0, message: null }

/**
 * Tracks the two-tier shared-folder status for the persistent "shared files
 * paused" banner (Slice 3e / Issue 3A). Fetches a snapshot on mount, then
 * follows STORAGE_SHARED_STATUS_CHANGED push events. Stays idle when the flag
 * is off (the handler returns paused:false) or the channel is unavailable.
 */
export function useSharedStorageStatus(): SharedStorageStatus {
  const [status, setStatus] = useState<SharedStorageStatus>(IDLE)

  useEffect(() => {
    let alive = true
    api
      .invoke<SharedStorageStatus>(IPC_CHANNELS.STORAGE_SHARED_STATUS)
      .then((s) => {
        if (alive && s) setStatus(s)
      })
      .catch(() => {
        /* flag off / handler missing → stay idle */
      })

    const off = api.on(IPC_CHANNELS.STORAGE_SHARED_STATUS_CHANGED, (next: unknown) => {
      if (next) setStatus(next as SharedStorageStatus)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return status
}
