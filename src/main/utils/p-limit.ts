/**
 * Run an async producer over a list of inputs with bounded concurrency.
 *
 *   inputs ──► [active ≤ concurrency] ──► results[]
 *                    │
 *                    └── first rejection ─► aborts the bundle (Promise.all semantics)
 *
 * Mirrors the "throw on first failure" behavior of a sequential `for ... await`
 * loop — callers expecting an exception on partial failure don't need to change.
 * Results preserve input order regardless of completion order.
 *
 *   await runWithConcurrency(items, 3, async (item) => {
 *     return await fetchSomething(item)
 *   })
 *
 * No external dependency — keep this tiny and obvious.
 */
export async function runWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  worker: (input: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (concurrency < 1) throw new Error('concurrency must be >= 1')
  if (inputs.length === 0) return []

  const results: TOutput[] = new Array(inputs.length)
  let nextIndex = 0

  async function runOne(): Promise<void> {
    while (true) {
      const i = nextIndex++
      if (i >= inputs.length) return
      results[i] = await worker(inputs[i]!, i)
    }
  }

  const lanes = Math.min(concurrency, inputs.length)
  // Promise.all rejects fast on the first error; in-flight workers in other
  // lanes will still resolve/reject but their results are discarded.
  await Promise.all(Array.from({ length: lanes }, () => runOne()))
  return results
}
