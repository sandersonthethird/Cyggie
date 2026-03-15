import { useEffect, useCallback } from 'react'
import { api } from '../api'

export function useIpcInvoke<T = unknown>(channel: string) {
  return useCallback(
    (...args: unknown[]): Promise<T> => {
      return api.invoke<T>(channel, ...args)
    },
    [channel]
  )
}

export function useIpcListener(channel: string, callback: (...args: unknown[]) => void) {
  useEffect(() => {
    const unsubscribe = api.on(channel, callback)
    return unsubscribe
  }, [channel, callback])
}
