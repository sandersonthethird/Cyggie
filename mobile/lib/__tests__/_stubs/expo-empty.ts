// Empty stub for Expo modules in vitest. Tests that need specific
// surfaces should vi.mock the module directly with a factory that
// returns whatever they need.
//
// `export const __isStub = true` makes it easy to assert in tests that
// the alias is wired correctly when debugging.

export const __isStub = true

const handler: ProxyHandler<Record<string, unknown>> = {
  get: (target, prop) =>
    prop in target ? target[prop as string] : (..._args: unknown[]) => undefined,
}
export default new Proxy({}, handler)
