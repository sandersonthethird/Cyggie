// Test-only stub for `react-native` so vitest can load mobile modules
// without choking on RN's Flow-typed index.js. Mobile pure-logic tests
// don't actually use any RN runtime APIs; the unit-test surface is just
// plain TypeScript. UI/component tests belong in a separate mobile-side
// runner that knows how to mock the RN bridge.

export const Platform = { OS: 'ios', select: (m: Record<string, unknown>) => m['ios'] }
export const StyleSheet = {
  create: <T>(s: T): T => s,
  hairlineWidth: 1,
}

// Anything else accessed at module-eval time → undefined. Tests should
// stub specific surfaces they need (e.g. AppState) via vi.mock.
const handler: ProxyHandler<Record<string, unknown>> = {
  get(target, prop) {
    if (prop in target) return target[prop as string]
    return undefined
  },
}
export default new Proxy({}, handler)
