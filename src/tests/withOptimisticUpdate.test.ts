import { describe, it, expect, vi } from 'vitest'
import { withOptimisticUpdate } from '../renderer/utils/withOptimisticUpdate'

describe('withOptimisticUpdate', () => {
  it('calls applyOptimistic before the IPC call', async () => {
    const order: string[] = []
    const applyOptimistic = () => order.push('apply')
    const ipcCall = async () => { order.push('ipc'); return 'result' }
    await withOptimisticUpdate(applyOptimistic, ipcCall, () => {})
    expect(order).toEqual(['apply', 'ipc'])
  })

  it('calls onSuccess with the IPC result on success', async () => {
    const onSuccess = vi.fn()
    await withOptimisticUpdate(() => {}, async () => 42, () => {}, onSuccess)
    expect(onSuccess).toHaveBeenCalledWith(42)
  })

  it('calls revert and rethrows on IPC failure', async () => {
    const revert = vi.fn()
    const ipcCall = async () => { throw new Error('ipc failed') }
    await expect(
      withOptimisticUpdate(() => {}, ipcCall, revert)
    ).rejects.toThrow('ipc failed')
    expect(revert).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onSuccess on failure', async () => {
    const onSuccess = vi.fn()
    const ipcCall = async (): Promise<number> => { throw new Error('fail') }
    await expect(
      withOptimisticUpdate(() => {}, ipcCall, () => {}, onSuccess)
    ).rejects.toThrow()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('works when onSuccess is omitted', async () => {
    await expect(
      withOptimisticUpdate(() => {}, async () => 'ok', () => {})
    ).resolves.toBe('ok')
  })
})
