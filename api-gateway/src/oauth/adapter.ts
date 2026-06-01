// Drizzle-backed Adapter for node-oidc-provider.
//
// node-oidc-provider tracks ~10 entity types (Session, Interaction,
// AuthorizationCode, AccessToken, RefreshToken, Client, Grant, etc.).
// Per the plan we split into four tables: oauth_clients, oauth_grants,
// oauth_refresh_tokens (explicit, with indexed surface columns for admin
// + security operations), and oauth_payloads (catch-all for the rest).
//
// Each Adapter instance is constructed per entity type via the factory
// (`new DrizzleAdapter(name)`) and routes through the table for that name.
// The library calls upsert/find/destroy etc. with the model id; we
// persist the full payload as jsonb while extracting a handful of
// indexed columns for the explicit tables.
//
// Slice 9 invariant: a refresh token presented AFTER the 60s grace
// window when its rotated_to_id is set is reuse — that triggers chain
// revocation in api-gateway/src/oauth/reuse-detection.ts (called by
// the token endpoint, not the adapter). The adapter itself never
// validates; it persists.

import { and, eq, lt, sql } from 'drizzle-orm'
import type { Adapter, AdapterPayload } from 'oidc-provider'
import type { getDb } from '../db'
import { schema } from '@cyggie/db'

// Models with their own indexed surface tables. Everything else falls
// through to oauth_payloads. The explicit set matches the plan's three
// named tables; expanding this requires a schema migration.
const EXPLICIT_MODELS = new Set(['Client', 'Grant', 'RefreshToken'])

function epochToTimestamp(seconds: number | undefined): Date | null {
  if (!seconds || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000)
}

// payload.exp is "expires at" in epoch seconds (set by oidc-provider).
// We also receive expiresIn as a fallback; prefer payload.exp when present.
function deriveExpiresAt(
  payload: AdapterPayload,
  expiresIn: number,
): Date | null {
  if (typeof payload.exp === 'number') return epochToTimestamp(payload.exp)
  if (expiresIn > 0) return new Date(Date.now() + expiresIn * 1000)
  return null
}

export class DrizzleAdapter implements Adapter {
  constructor(
    private readonly name: string,
    private readonly db: ReturnType<typeof getDb>,
  ) {}

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<void> {
    const expiresAt = deriveExpiresAt(payload, expiresIn)

    if (this.name === 'Client') {
      // Persisted-DCR + admin-provisioned clients. payload.client_id is
      // typically the same as id, but oidc-provider treats them separately.
      const clientId = (payload['client_id'] as string | undefined) ?? id
      const clientName = (payload['client_name'] as string | undefined) ?? null
      await this.db
        .insert(schema.oauthClients)
        .values({
          id,
          payload,
          clientId,
          clientName,
          firmId: (payload['firm_id'] as string | undefined) ?? null,
          createdByUserId:
            (payload['created_by_user_id'] as string | undefined) ?? null,
        })
        .onConflictDoUpdate({
          target: schema.oauthClients.id,
          set: {
            payload,
            clientId,
            clientName,
            updatedAt: new Date(),
          },
        })
      return
    }

    if (this.name === 'Grant') {
      await this.db
        .insert(schema.oauthGrants)
        .values({
          id,
          payload,
          accountId: (payload.accountId as string | undefined) ?? null,
          clientId: (payload.clientId as string | undefined) ?? null,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: schema.oauthGrants.id,
          set: {
            payload,
            accountId: (payload.accountId as string | undefined) ?? null,
            clientId: (payload.clientId as string | undefined) ?? null,
            expiresAt,
          },
        })
      return
    }

    if (this.name === 'RefreshToken') {
      await this.db
        .insert(schema.oauthRefreshTokens)
        .values({
          id,
          payload,
          accountId: (payload.accountId as string | undefined) ?? null,
          clientId: (payload.clientId as string | undefined) ?? null,
          grantId: (payload.grantId as string | undefined) ?? null,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: schema.oauthRefreshTokens.id,
          set: {
            payload,
            // accountId / clientId / grantId never change after issuance.
            // expiresAt only changes if oidc-provider re-issues (it doesn't).
          },
        })
      return
    }

    // Catch-all. Two indexed-surface columns used by oidc-provider:
    // uid (Session lookup) and userCode (DeviceCode flow).
    const uid = (payload.uid as string | undefined) ?? null
    const userCode = (payload['userCode'] as string | undefined) ?? null
    await this.db
      .insert(schema.oauthPayloads)
      .values({
        name: this.name,
        id,
        payload,
        expiresAt,
        uid,
        userCode,
      })
      .onConflictDoUpdate({
        target: [schema.oauthPayloads.name, schema.oauthPayloads.id],
        set: { payload, expiresAt, uid, userCode },
      })
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    if (this.name === 'Client') {
      const rows = await this.db
        .select({ payload: schema.oauthClients.payload })
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, id))
        .limit(1)
      return (rows[0]?.payload as AdapterPayload | undefined) ?? undefined
    }
    if (this.name === 'Grant') {
      const rows = await this.db
        .select({
          payload: schema.oauthGrants.payload,
          expiresAt: schema.oauthGrants.expiresAt,
        })
        .from(schema.oauthGrants)
        .where(eq(schema.oauthGrants.id, id))
        .limit(1)
      const row = rows[0]
      if (!row) return undefined
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined
      return row.payload as AdapterPayload
    }
    if (this.name === 'RefreshToken') {
      const rows = await this.db
        .select({
          payload: schema.oauthRefreshTokens.payload,
          expiresAt: schema.oauthRefreshTokens.expiresAt,
          revokedAt: schema.oauthRefreshTokens.revokedAt,
        })
        .from(schema.oauthRefreshTokens)
        .where(eq(schema.oauthRefreshTokens.id, id))
        .limit(1)
      const row = rows[0]
      if (!row) return undefined
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined
      // Don't honor revoked tokens. The reuse-detection logic in the
      // token endpoint distinguishes "rotated-within-grace" (valid) from
      // "rotated-and-grace-expired" (reuse) before calling find; this
      // is the belt to that suspenders.
      if (row.revokedAt) return undefined
      return row.payload as AdapterPayload
    }
    // Catch-all.
    const rows = await this.db
      .select({
        payload: schema.oauthPayloads.payload,
        expiresAt: schema.oauthPayloads.expiresAt,
      })
      .from(schema.oauthPayloads)
      .where(
        and(
          eq(schema.oauthPayloads.name, this.name),
          eq(schema.oauthPayloads.id, id),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    // Only DeviceCode uses this; lives in oauth_payloads.
    const rows = await this.db
      .select({
        payload: schema.oauthPayloads.payload,
        expiresAt: schema.oauthPayloads.expiresAt,
      })
      .from(schema.oauthPayloads)
      .where(
        and(
          eq(schema.oauthPayloads.name, this.name),
          eq(schema.oauthPayloads.userCode, userCode),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    // Only Session uses this — lives in oauth_payloads.
    const rows = await this.db
      .select({
        payload: schema.oauthPayloads.payload,
        expiresAt: schema.oauthPayloads.expiresAt,
      })
      .from(schema.oauthPayloads)
      .where(
        and(
          eq(schema.oauthPayloads.name, this.name),
          eq(schema.oauthPayloads.uid, uid),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async consume(id: string): Promise<void> {
    // Mark consumed = set payload.consumed = unix time. oidc-provider
    // reads payload.consumed in find() to enforce single-use semantics
    // (AuthorizationCode). For our explicit-table types, the model
    // doesn't currently use consume(); the catch-all path covers
    // AuthorizationCode (which lives in oauth_payloads).
    const now = Math.floor(Date.now() / 1000)
    if (EXPLICIT_MODELS.has(this.name)) {
      // Defensive — should never hit for V1 model set.
      throw new Error(
        `consume() called on explicit-table model "${this.name}"; not implemented`,
      )
    }
    await this.db
      .update(schema.oauthPayloads)
      .set({
        payload: sql`jsonb_set(${schema.oauthPayloads.payload}, '{consumed}', to_jsonb(${now}::bigint), true)`,
      })
      .where(
        and(
          eq(schema.oauthPayloads.name, this.name),
          eq(schema.oauthPayloads.id, id),
        ),
      )
  }

  async destroy(id: string): Promise<void> {
    if (this.name === 'Client') {
      await this.db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, id))
      return
    }
    if (this.name === 'Grant') {
      await this.db.delete(schema.oauthGrants).where(eq(schema.oauthGrants.id, id))
      return
    }
    if (this.name === 'RefreshToken') {
      await this.db
        .delete(schema.oauthRefreshTokens)
        .where(eq(schema.oauthRefreshTokens.id, id))
      return
    }
    await this.db
      .delete(schema.oauthPayloads)
      .where(
        and(
          eq(schema.oauthPayloads.name, this.name),
          eq(schema.oauthPayloads.id, id),
        ),
      )
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Cascade revocation: when a Grant is revoked, every token under it
    // dies. For tokens stored in their explicit tables, the column is
    // indexed; for tokens in oauth_payloads (AccessToken etc.), we have
    // to scan by payload->>'grantId' — slower but small at V1 volume.
    await this.db
      .delete(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.grantId, grantId))
    await this.db
      .delete(schema.oauthPayloads)
      .where(sql`${schema.oauthPayloads.payload} ->> 'grantId' = ${grantId}`)
  }
}

// Cleanup helper — sweeps expired rows from oauth_payloads. Call from a
// cron / setInterval; not invoked by the adapter itself.
export async function sweepExpiredOAuthPayloads(
  db: ReturnType<typeof getDb>,
): Promise<number> {
  const result = await db
    .delete(schema.oauthPayloads)
    .where(lt(schema.oauthPayloads.expiresAt, new Date()))
  // Drizzle's delete returns { rowCount } in pg driver.
  return (result as unknown as { rowCount?: number }).rowCount ?? 0
}
