import net from 'node:net'

// Port preflight for the embedded-Postgres test harness.
//
// The hermetic test.env URL hardcodes a fixed port, so the boot must fail
// with an *actionable* message (not a cryptic connection timeout) when that
// port is already taken — e.g. a dev's local Postgres, or a leftover embedded
// instance from a crashed run. Extracted from global-setup.ts so the
// port-in-use branch is unit-testable (it never fires in a normal run).

export function portInUseMessage(port: number): string {
  return (
    `[test-db] Port ${port} is already in use — the gateway test suite needs ` +
    `it for an ephemeral Postgres. Stop whatever is listening there (often a ` +
    `local Postgres or a leftover embedded instance from a crashed run), or ` +
    `set TEST_PG_PORT to a free port.`
  )
}

// Resolves if the port is free; rejects with an actionable Error (using
// portInUseMessage) if it's already bound. Any other bind error is surfaced
// as-is. Checks the same host the embedded cluster binds (127.0.0.1).
export function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(portInUseMessage(port)))
      else reject(err)
    })
    server.once('listening', () => {
      server.close(() => resolve())
    })
    server.listen(port, '127.0.0.1')
  })
}
