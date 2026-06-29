import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { and, eq, isNull } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { signAccessToken } from '../auth/jwt'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { getDb } from '../db'

// Multi-tenant firm routes. Onboarding lives at /auth/firms/{claim,join}; ongoing
// firm management at /firms/me/**.
//
//   FLOW A — CREATE WORKSPACE (first-from-firm):
//     OAuth → no firm_id → mobile shows "create workspace" CTA
//     → POST /auth/firms/claim → caller becomes role=admin of new firm
//     → response carries a fresh access_token with firm_id baked in
//
//   FLOW B — ACCEPT INVITE (subsequent partners):
//     admin generates invite → emails magic link cyggie://invite/<token>
//     → invitee taps → OAuth → POST /auth/firms/join
//     → email match required (token + JWT email must agree)
//     → response carries a fresh access_token with firm_id baked in
//
//   FLOW C — DOMAIN AUTO-JOIN (deferred to M6):
//     OAuth callback inspects firms.primary_email_domain. Out of scope here.
//
//   FLOW D — RETURNING USER:
//     OAuth → user found → firm_id already set → access_token issued at
//     /auth/google/callback. No firms route involved.

// Slug constraints: lowercase letters/digits/hyphens, 3-64 chars, no leading/
// trailing hyphen, no double-hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/
const slugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(SLUG_RE, 'slug must be lowercase alphanumeric with single hyphens')

// RFC-1035-ish domain: 1+ labels separated by dots, each 1-63 chars, total ≤253.
// Permissive — we are tracking the email domain for auto-join hints, not
// authenticating against the DNS root.
const domainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, 'invalid domain')

interface FirmRoutesDeps {
  env: GatewayEnv
}

export async function registerFirmRoutes(
  app: FastifyInstance,
  deps: FirmRoutesDeps,
): Promise<void> {
  const { env } = deps
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ─────────────────────────────────────────────────────────────────────────
  // Flow A — POST /auth/firms/claim
  // Caller must be authenticated but firm_id must currently be null (the
  // pre-onboarding state). Creates firm, marks caller as admin, returns a
  // fresh access_token with the new firm_id claim so the next request can
  // hit /firms/me without an extra /auth/refresh.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/auth/firms/claim',
    schema: {
      body: z.object({
        name: z.string().min(1).max(200),
        slug: slugSchema,
        primary_email_domain: domainSchema.optional(),
        domain_auto_join: z.boolean().optional(),
        // Firm-type template (Slice B). Free string, validated leniently — the
        // desktop's resolveFirmTemplate maps unknown/null ids to 'vc', so a new
        // template never needs a gateway deploy. Defaults to 'vc' for back-compat.
        template_id: z.string().min(1).max(32).optional(),
      }),
      response: {
        200: z.object({
          access_token: z.string(),
          firm: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            primary_email_domain: z.string().nullable(),
            domain_auto_join: z.boolean(),
            plan: z.string(),
          }),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireUser()
      if (user.firm_id) {
        throw new GatewayError({
          statusCode: 409,
          code: 'ALREADY_IN_FIRM',
          message: 'User already belongs to a firm. Use a different account or leave the current firm first.',
        })
      }

      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { name, slug, primary_email_domain, domain_auto_join, template_id } = req.body

      // Slug uniqueness check up front. Race-safe at the DB level too (unique
      // index on firms.slug) but a friendly 409 beats a 500 here.
      const slugTaken = await db.query.firms.findFirst({
        where: eq(schema.firms.slug, slug),
      })
      if (slugTaken) {
        throw new GatewayError({
          statusCode: 409,
          code: 'SLUG_TAKEN',
          message: 'That slug is already taken. Pick another.',
        })
      }

      const firmId = createId()
      const now = new Date()
      // 14-day default trial. Manual extension in Neon during the beta cohort.
      const trialEndsAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

      await db.transaction(async (tx) => {
        await tx.insert(schema.firms).values({
          id: firmId,
          name,
          slug,
          primaryEmailDomain: primary_email_domain?.toLowerCase() ?? null,
          domainAutoJoin: domain_auto_join ?? false,
          templateId: template_id ?? 'vc',
          plan: 'trial',
          trialEndsAt,
        })
        await tx
          .update(schema.users)
          .set({ firmId, role: 'admin', updatedAt: now })
          .where(eq(schema.users.id, user.sub))
        await tx.insert(schema.auditLog).values({
          userId: user.sub,
          deviceId: user.device,
          eventType: 'firm.create',
          actor: 'user',
          details: { firm_id: firmId, slug, name },
        })
      })

      const accessToken = await signAccessToken(env.JWT_SIGNING_SECRET, {
        sub: user.sub,
        sid: user.sid,
        device: user.device,
        scope: user.scope,
        firm_id: firmId,
        role: 'admin',
      })

      req.log.info({ userId: user.sub, firmId, slug }, 'firm.create')

      return {
        access_token: accessToken,
        firm: {
          id: firmId,
          name,
          slug,
          primary_email_domain: primary_email_domain?.toLowerCase() ?? null,
          domain_auto_join: domain_auto_join ?? false,
          plan: 'trial',
        },
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Flow B — POST /auth/firms/join
  // Resolves an invite token, verifies the email matches the caller's OAuth
  // identity, attaches the caller to the firm as 'member'.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/auth/firms/join',
    schema: {
      body: z.object({
        token: z.string().min(20).max(200),
      }),
      response: {
        200: z.object({
          access_token: z.string(),
          firm: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            plan: z.string(),
          }),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireUser()
      if (user.firm_id) {
        throw new GatewayError({
          statusCode: 409,
          code: 'ALREADY_IN_FIRM',
          message: 'User already belongs to a firm.',
        })
      }

      const db = getDb(env.GATEWAY_DATABASE_URL)
      const tokenHash = createHash('sha256').update(req.body.token).digest('hex')

      const invite = await db.query.invites.findFirst({
        where: eq(schema.invites.tokenHash, tokenHash),
      })
      if (!invite) {
        throw new GatewayError({
          statusCode: 404,
          code: 'INVITE_NOT_FOUND',
          message: 'Invite token is unknown or has already been consumed',
        })
      }
      if (invite.acceptedAt) {
        throw new GatewayError({
          statusCode: 409,
          code: 'INVITE_ALREADY_ACCEPTED',
          message: 'Invite has already been accepted',
        })
      }
      if (invite.revokedAt) {
        throw new GatewayError({
          statusCode: 410,
          code: 'INVITE_REVOKED',
          message: 'Invite has been revoked by an admin',
        })
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        throw new GatewayError({
          statusCode: 410,
          code: 'INVITE_EXPIRED',
          message: 'Invite has expired. Ask an admin to send a new one.',
        })
      }

      // Email match: invite was issued to a specific email. The OAuth identity
      // email (stored on the user row) must match. Prevents accidental or
      // intentional invite forwarding to a different account.
      const userRow = await db.query.users.findFirst({
        where: eq(schema.users.id, user.sub),
      })
      if (!userRow) {
        throw new GatewayError({
          statusCode: 401,
          code: 'USER_NOT_FOUND',
          message: 'User in token no longer exists',
        })
      }
      if (userRow.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new GatewayError({
          statusCode: 403,
          code: 'INVITE_EMAIL_MISMATCH',
          message: 'Invite was issued to a different email address',
        })
      }

      const firm = await db.query.firms.findFirst({
        where: eq(schema.firms.id, invite.firmId),
      })
      if (!firm) {
        throw new GatewayError({
          statusCode: 410,
          code: 'FIRM_DELETED',
          message: 'The firm that issued this invite has been deleted',
        })
      }

      const now = new Date()
      await db.transaction(async (tx) => {
        await tx
          .update(schema.users)
          .set({
            firmId: invite.firmId,
            role: 'member',
            invitedByUserId: invite.invitedByUserId,
            updatedAt: now,
          })
          .where(eq(schema.users.id, user.sub))
        await tx
          .update(schema.invites)
          .set({ acceptedAt: now, acceptedByUserId: user.sub })
          .where(eq(schema.invites.id, invite.id))
        await tx.insert(schema.auditLog).values({
          userId: user.sub,
          deviceId: user.device,
          eventType: 'firm.invite.accept',
          actor: 'user',
          details: { firm_id: invite.firmId, invite_id: invite.id },
        })
      })

      const accessToken = await signAccessToken(env.JWT_SIGNING_SECRET, {
        sub: user.sub,
        sid: user.sid,
        device: user.device,
        scope: user.scope,
        firm_id: invite.firmId,
        role: 'member',
      })

      req.log.info(
        { userId: user.sub, firmId: invite.firmId, inviteId: invite.id },
        'firm.invite.accept',
      )

      return {
        access_token: accessToken,
        firm: {
          id: firm.id,
          name: firm.name,
          slug: firm.slug,
          plan: firm.plan,
        },
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GET /firms/me — current firm details. Auth + firm_id required.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/firms/me',
    schema: {
      response: {
        200: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          primary_email_domain: z.string().nullable(),
          domain_auto_join: z.boolean(),
          // Firm-type template (Slice B). Null for pre-Slice-B firms → desktop's
          // resolveFirmTemplate falls back to 'vc'. Desktop reads this to seed the
          // right default views/labels/field-options for the firm.
          template_id: z.string().nullable(),
          plan: z.string(),
          trial_ends_at: z.string().nullable(),
          created_at: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const firm = await db.query.firms.findFirst({
        where: eq(schema.firms.id, u.firm_id),
      })
      if (!firm) {
        throw new GatewayError({
          statusCode: 404,
          code: 'FIRM_NOT_FOUND',
          message: 'Firm in token no longer exists',
        })
      }
      return {
        id: firm.id,
        name: firm.name,
        slug: firm.slug,
        primary_email_domain: firm.primaryEmailDomain,
        domain_auto_join: firm.domainAutoJoin,
        template_id: firm.templateId,
        plan: firm.plan,
        trial_ends_at: firm.trialEndsAt ? firm.trialEndsAt.toISOString() : null,
        created_at: firm.createdAt.toISOString(),
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /firms/me — admin only. Update name/domain/auto_join.
  // Slug is intentionally immutable in V1 — any future per-firm subdomain
  // routing would break on slug changes.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/firms/me',
    schema: {
      body: z.object({
        name: z.string().min(1).max(200).optional(),
        primary_email_domain: domainSchema.nullable().optional(),
        domain_auto_join: z.boolean().optional(),
      }),
      response: {
        200: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          primary_email_domain: z.string().nullable(),
          domain_auto_join: z.boolean(),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireAdmin()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const updates: Partial<typeof schema.firms.$inferInsert> = {
        updatedAt: new Date(),
      }
      if (req.body.name !== undefined) updates.name = req.body.name
      if (req.body.primary_email_domain !== undefined) {
        updates.primaryEmailDomain = req.body.primary_email_domain?.toLowerCase() ?? null
      }
      if (req.body.domain_auto_join !== undefined) {
        updates.domainAutoJoin = req.body.domain_auto_join
      }
      const [updated] = await db
        .update(schema.firms)
        .set(updates)
        .where(eq(schema.firms.id, u.firm_id))
        .returning()
      if (!updated) {
        throw new GatewayError({
          statusCode: 404,
          code: 'FIRM_NOT_FOUND',
          message: 'Firm no longer exists',
        })
      }
      await db.insert(schema.auditLog).values({
        userId: u.sub,
        deviceId: u.device,
        eventType: 'firm.update',
        actor: 'user',
        details: { firm_id: u.firm_id, changes: req.body },
      })
      return {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        primary_email_domain: updated.primaryEmailDomain,
        domain_auto_join: updated.domainAutoJoin,
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // POST /firms/me/invites — admin only. Generate an invite token.
  // Returns the raw token exactly once; only the hash is persisted. The admin
  // must communicate the token to the invitee (M2 wires Resend; until then
  // they email/Slack it manually).
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/firms/me/invites',
    schema: {
      body: z.object({
        email: z.string().email().max(320),
      }),
      response: {
        200: z.object({
          id: z.string(),
          email: z.string(),
          token: z.string(), // raw — returned exactly once
          expires_at: z.string(),
          deep_link: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireAdmin()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const email = req.body.email.toLowerCase()

      // Anti-spam: refuse if an unaccepted, non-revoked invite already exists.
      const existing = await db.query.invites.findFirst({
        where: and(
          eq(schema.invites.firmId, u.firm_id),
          eq(schema.invites.email, email),
          isNull(schema.invites.acceptedAt),
          isNull(schema.invites.revokedAt),
        ),
      })
      if (existing && existing.expiresAt.getTime() > Date.now()) {
        throw new GatewayError({
          statusCode: 409,
          code: 'INVITE_ALREADY_PENDING',
          message: 'A pending invite for this email already exists. Revoke it first or wait for expiry.',
        })
      }

      const rawToken = randomBytes(32).toString('base64url')
      const tokenHash = createHash('sha256').update(rawToken).digest('hex')
      const inviteId = createId()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await db.insert(schema.invites).values({
        id: inviteId,
        firmId: u.firm_id,
        email,
        tokenHash,
        invitedByUserId: u.sub,
        expiresAt,
      })
      await db.insert(schema.auditLog).values({
        userId: u.sub,
        deviceId: u.device,
        eventType: 'firm.invite.create',
        actor: 'user',
        details: { firm_id: u.firm_id, invite_id: inviteId, email },
      })

      return {
        id: inviteId,
        email,
        token: rawToken,
        expires_at: expiresAt.toISOString(),
        // Mobile catches this scheme via expo-router. M2 emails this via Resend.
        deep_link: `cyggie://invite/${rawToken}`,
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GET /firms/me/invites — admin only. List pending invites.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/firms/me/invites',
    schema: {
      response: {
        200: z.object({
          invites: z.array(
            z.object({
              id: z.string(),
              email: z.string(),
              expires_at: z.string(),
              created_at: z.string(),
              invited_by_user_id: z.string(),
            }),
          ),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireAdmin()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const rows = await db.query.invites.findMany({
        where: and(
          eq(schema.invites.firmId, u.firm_id),
          isNull(schema.invites.acceptedAt),
          isNull(schema.invites.revokedAt),
        ),
      })
      return {
        invites: rows.map((r) => ({
          id: r.id,
          email: r.email,
          expires_at: r.expiresAt.toISOString(),
          created_at: r.createdAt.toISOString(),
          invited_by_user_id: r.invitedByUserId,
        })),
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /firms/me/invites/:id — admin only. Revoke a pending invite.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'DELETE',
    url: '/firms/me/invites/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const u = req.requireAdmin()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const invite = await db.query.invites.findFirst({
        where: eq(schema.invites.id, req.params.id),
      })
      if (!invite || invite.firmId !== u.firm_id) {
        throw new GatewayError({
          statusCode: 404,
          code: 'INVITE_NOT_FOUND',
          message: 'Invite not found in this firm',
        })
      }
      if (invite.acceptedAt) {
        throw new GatewayError({
          statusCode: 409,
          code: 'INVITE_ALREADY_ACCEPTED',
          message: 'Cannot revoke an already-accepted invite',
        })
      }
      await db
        .update(schema.invites)
        .set({ revokedAt: new Date() })
        .where(eq(schema.invites.id, invite.id))
      await db.insert(schema.auditLog).values({
        userId: u.sub,
        deviceId: u.device,
        eventType: 'firm.invite.revoke',
        actor: 'user',
        details: { firm_id: u.firm_id, invite_id: invite.id },
      })
      return { ok: true as const }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Firm-wide storage config (two-tier storage, Slice 2).
  //
  // The admin-designated SHARED files location lives here as a MOUNT-RELATIVE
  // Drive spec — never an absolute path, because a shared Google Drive folder
  // resolves to a different absolute path on each user's machine. Each desktop
  // client resolves rel_path against its own ~/…/CloudStorage/GoogleDrive-<acct>/.
  //
  //   admin  PUT  /firms/me/storage-config  (requireAdmin) → upsert
  //   member GET  /firms/me/storage-config  (requireFirm)  → read (inherit)
  //
  // Stored in firm_settings under key 'storageConfig' as a JSON string.
  // ─────────────────────────────────────────────────────────────────────────
  const STORAGE_CONFIG_KEY = 'storageConfig'

  // rel_path must be a clean *relative* path: no leading slash, no '..' or empty
  // segments (path-traversal guard — the client joins this onto its CloudStorage
  // root, so a '..' could escape it). Forward slashes only; backslashes rejected.
  const relPathSchema = z
    .string()
    .min(1)
    .max(512)
    .refine(
      (p) =>
        !p.startsWith('/') &&
        !p.includes('\\') &&
        !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.'),
      'rel_path must be a clean relative path (no leading slash, no ".." or empty segments)',
    )

  const storageConfigShape = z.object({
    provider: z.literal('gdrive'),
    rel_path: relPathSchema,
  })

  fastifyTyped.route({
    method: 'GET',
    url: '/firms/me/storage-config',
    schema: {
      response: {
        200: z.object({
          storage_config: storageConfigShape.nullable(),
          updated_by_user_id: z.string().nullable(),
          updated_at: z.string().nullable(),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const row = await db.query.firmSettings.findFirst({
        where: and(
          eq(schema.firmSettings.firmId, u.firm_id),
          eq(schema.firmSettings.key, STORAGE_CONFIG_KEY),
        ),
      })
      if (!row) {
        return { storage_config: null, updated_by_user_id: null, updated_at: null }
      }
      // Stored value is admin-validated JSON; parse defensively so a malformed
      // row degrades to "unset" rather than 500-ing every client that polls it.
      let parsed: { provider: 'gdrive'; rel_path: string } | null = null
      try {
        const candidate = JSON.parse(row.value)
        parsed = storageConfigShape.parse(candidate)
      } catch {
        req.log.warn({ firmId: u.firm_id }, 'firm storage-config row is malformed; returning null')
      }
      return {
        storage_config: parsed,
        updated_by_user_id: row.updatedByUserId,
        updated_at: row.updatedAt.toISOString(),
      }
    },
  })

  fastifyTyped.route({
    method: 'PUT',
    url: '/firms/me/storage-config',
    schema: {
      body: storageConfigShape,
      response: {
        200: z.object({
          storage_config: storageConfigShape,
          updated_by_user_id: z.string(),
          updated_at: z.string(),
        }),
      },
    },
    handler: async (req) => {
      // Admin-only — requireAdmin throws the stable 403 ADMIN_REQUIRED for
      // members. The shared location is a firm-wide setting only an admin may set.
      const u = req.requireAdmin()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const value = JSON.stringify({
        provider: req.body.provider,
        rel_path: req.body.rel_path,
      })
      const now = new Date()
      const [row] = await db
        .insert(schema.firmSettings)
        .values({
          firmId: u.firm_id,
          key: STORAGE_CONFIG_KEY,
          value,
          updatedByUserId: u.sub,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.firmSettings.firmId, schema.firmSettings.key],
          set: { value, updatedByUserId: u.sub, updatedAt: now },
        })
        .returning()
      if (!row) {
        throw new GatewayError({
          statusCode: 500,
          code: 'STORAGE_CONFIG_WRITE_FAILED',
          message: 'Failed to persist firm storage config',
        })
      }
      await db.insert(schema.auditLog).values({
        userId: u.sub,
        deviceId: u.device,
        eventType: 'firm.storage_config.update',
        actor: 'user',
        details: { firm_id: u.firm_id, rel_path: req.body.rel_path },
      })
      return {
        storage_config: { provider: req.body.provider, rel_path: req.body.rel_path },
        updated_by_user_id: u.sub,
        updated_at: now.toISOString(),
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GET /firms/me/members — list firm members with roles.
  // Any firm member can list — needed for the chat UI to attribute mentions.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/firms/me/members',
    schema: {
      response: {
        200: z.object({
          members: z.array(
            z.object({
              id: z.string(),
              email: z.string(),
              display_name: z.string().nullable(),
              avatar_url: z.string().nullable(),
              role: z.enum(['admin', 'member']),
              is_active: z.boolean(),
              created_at: z.string(),
            }),
          ),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const rows = await db.query.users.findMany({
        where: eq(schema.users.firmId, u.firm_id),
      })
      return {
        members: rows.map((r) => ({
          id: r.id,
          email: r.email,
          display_name: r.displayName,
          avatar_url: r.avatarUrl,
          role: r.role === 'admin' ? ('admin' as const) : ('member' as const),
          is_active: r.isActive,
          created_at: r.createdAt.toISOString(),
        })),
      }
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /firms/me/members/:userId — admin only. Promote/demote/deactivate.
  // Cannot demote or deactivate yourself (last-admin protection lives at the
  // route level — V1 doesn't run a quorum check, just self-protection).
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/firms/me/members/:userId',
    schema: {
      params: z.object({ userId: z.string().min(1).max(64) }),
      body: z.object({
        role: z.enum(['admin', 'member']).optional(),
        is_active: z.boolean().optional(),
      }),
      response: {
        200: z.object({
          id: z.string(),
          role: z.enum(['admin', 'member']),
          is_active: z.boolean(),
        }),
      },
    },
    handler: async (req) => {
      const u = req.requireAdmin()
      if (req.params.userId === u.sub) {
        throw new GatewayError({
          statusCode: 403,
          code: 'SELF_MODIFY_FORBIDDEN',
          message: 'Admin cannot modify their own role or active status. Ask another admin.',
        })
      }
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const target = await db.query.users.findFirst({
        where: eq(schema.users.id, req.params.userId),
      })
      if (!target || target.firmId !== u.firm_id) {
        throw new GatewayError({
          statusCode: 404,
          code: 'MEMBER_NOT_FOUND',
          message: 'Target user is not a member of this firm',
        })
      }
      const updates: Partial<typeof schema.users.$inferInsert> = {
        updatedAt: new Date(),
      }
      if (req.body.role !== undefined) updates.role = req.body.role
      if (req.body.is_active !== undefined) updates.isActive = req.body.is_active
      const [updated] = await db
        .update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, target.id))
        .returning()
      if (!updated) {
        throw new GatewayError({
          statusCode: 404,
          code: 'MEMBER_NOT_FOUND',
          message: 'Member disappeared mid-update',
        })
      }
      await db.insert(schema.auditLog).values({
        userId: u.sub,
        deviceId: u.device,
        eventType: 'firm.member.update',
        actor: 'user',
        details: { firm_id: u.firm_id, target_user_id: target.id, changes: req.body },
      })
      return {
        id: updated.id,
        role: updated.role === 'admin' ? ('admin' as const) : ('member' as const),
        is_active: updated.isActive,
      }
    },
  })
}
