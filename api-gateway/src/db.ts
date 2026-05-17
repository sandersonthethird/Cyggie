import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { schema } from '@cyggie/db'

// Single Postgres pool for the gateway. drizzle wraps the pool with the schema
// from @cyggie/db. Use this throughout the gateway for all DB access.
//
// Note: gateway runs on Fly with HTTP-based pooling to Neon, not classic pg pool
// against a direct compute endpoint. The Neon serverless package (`@neondatabase/serverless`)
// is what packages/db's drizzle.config.ts uses for `drizzle-kit push/migrate`. For
// the gateway *runtime*, classic `pg` with the Neon pooler endpoint works fine and
// avoids `@neondatabase/serverless`'s websocket overhead per-query.

let _pool: pg.Pool | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getPool(connectionString: string): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString,
      max: 16,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  }
  return _pool
}

export function getDb(connectionString: string) {
  if (!_db) {
    _db = drizzle(getPool(connectionString), { schema })
  }
  return _db
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
    _db = null
  }
}
