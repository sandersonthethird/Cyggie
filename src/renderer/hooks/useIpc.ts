import { useEffect, useCallback } from 'react'
import { api } from '../api'
import type { IpcChannel } from '../../shared/types/ipc'

export function useIpcInvoke<T = unknown>(channel: IpcChannel) {
  return useCallback(
    (...args: unknown[]): Promise<T> => {
      return api.invoke<T>(channel, ...args)
    },
    [channel]
  )
}

export function useIpcListener(channel: IpcChannel, callback: (...args: unknown[]) => void) {
  useEffect(() => {
    const unsubscribe = api.on(channel, callback)
    return unsubscribe
  }, [channel, callback])
}
