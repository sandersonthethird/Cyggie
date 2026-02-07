import { useEffect, useCallback } from 'react'

export function useIpcInvoke<T = unknown>(channel: string) {
  return useCallback(
    (...args: unknown[]): Promise<T> => {
      return window.api.invoke<T>(channel, ...args)
    },
    [channel]
  )
}

export function useIpcListener(channel: string, callback: (...args: unknown[]) => void) {
  useEffect(() => {
    const unsubscribe = window.api.on(channel, callback)
    return unsubscribe
  }, [channel, callback])
}
