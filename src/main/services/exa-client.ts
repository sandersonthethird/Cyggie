import { Exa } from 'exa-js'
import { getCredential } from '../security/credentials'

/**
 * Shared Exa client accessor. The Exa API key lives in the encrypted settings
 * store under the credential key `exaApiKey`. Modules that need Exa import
 * `getExaClient()` rather than constructing their own — keeps a single place
 * to swap providers, share retry/timeout policy, and surface key-missing
 * errors consistently.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  Callers:                                                   │
 *   │   • exa-linkedin-discovery.service.ts (existing)           │
 *   │   • exa-research.ts (new — memo pre-research + agent tools)│
 *   └────────────────────────────────────────────────────────────┘
 *
 * The client is instantiated fresh per call. The Exa SDK is cheap to construct
 * and re-using one across IPC boundaries risks stale auth if the user rotates
 * the key. Cost: ~one object per call, no socket pool to reset.
 */

export class ExaKeyMissingError extends Error {
  constructor() {
    super('Exa API key not configured. Add it in Settings → Integrations.')
    this.name = 'ExaKeyMissingError'
  }
}

export function getExaClient(): Exa {
  const apiKey = getCredential('exaApiKey')
  if (!apiKey) throw new ExaKeyMissingError()
  return new Exa(apiKey)
}

/**
 * Test affordance: returns a no-throwing `Exa | null`. Callers that prefer
 * a graceful-degrade path (e.g. memo-generator's pre-research can run with
 * zero results if Exa isn't configured) use this instead of getExaClient.
 */
export function tryGetExaClient(): Exa | null {
  try {
    return getExaClient()
  } catch (err) {
    if (err instanceof ExaKeyMissingError) return null
    throw err
  }
}
