import type { FastifyInstance } from 'fastify'
import type { GatewayEnv } from '../env'

// Dev-only smoke-test routes. Mounted only when NODE_ENV !== 'production'.
// Used to verify Sentry inbox wiring during Phase 0.6 operational onboarding.

class SentrySmokeError extends Error {
  constructor() {
    super('Sentry smoke-test: synthetic error from /_debug/sentry-test')
    this.name = 'SentrySmokeError'
  }
}

export async function registerDebugRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  if (env.NODE_ENV === 'production') return

  app.get('/_debug/sentry-test', async () => {
    throw new SentrySmokeError()
  })
}
