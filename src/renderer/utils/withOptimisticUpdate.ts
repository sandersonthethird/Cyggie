/**
 * Applies an optimistic state update, fires an async IPC call, then:
 * - on success: calls optional onSuccess with the result
 * - on error:   reverts the optimistic update and re-throws
 *
 * Re-throwing is intentional — callers like PropertyRow.handleSave
 * rely on the thrown error to revert their local displayValue.
 *
 *  applyOptimistic() ──▶ ipcCall()
 *       │                    │
 *       │              success│   error│
 *       │                    ▼        ▼
 *       │             onSuccess?()  revert()
 *       │                              │
 *       │                           throw err
 *       ▼
 *  (parent state already reflects new value)
 */
export async function withOptimisticUpdate<T>(
  applyOptimistic: () => void,
  ipcCall: () => Promise<T>,
  revert: () => void,
  onSuccess?: (result: T) => void,
): Promise<T> {
  applyOptimistic()
  try {
    const result = await ipcCall()
    onSuccess?.(result)
    return result
  } catch (err) {
    revert()
    throw err
  }
}
