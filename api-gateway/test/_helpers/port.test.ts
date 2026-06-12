import { afterEach, describe, expect, test } from 'vitest'
import net from 'node:net'
import { assertPortAvailable, portInUseMessage } from './port'

// Issue 9A: the port-in-use branch of the embedded-PG preflight never fires in
// a normal run, so cover it directly. Uses an ephemeral throwaway port (never
// the real test-PG port) so the running suite is unaffected.

let server: net.Server | undefined

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  }
})

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      server = s
      resolve((s.address() as net.AddressInfo).port)
    })
  })
}

describe('assertPortAvailable', () => {
  test('rejects with an actionable message when the port is taken', async () => {
    const port = await listenOnEphemeralPort()
    await expect(assertPortAvailable(port)).rejects.toThrow(portInUseMessage(port))
  })

  test('mentions TEST_PG_PORT in the actionable message', () => {
    expect(portInUseMessage(54329)).toContain('TEST_PG_PORT')
    expect(portInUseMessage(54329)).toContain('54329')
  })

  test('resolves when the port is free', async () => {
    const port = await listenOnEphemeralPort()
    // free it, then the same port should be available again
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    await expect(assertPortAvailable(port)).resolves.toBeUndefined()
  })
})
