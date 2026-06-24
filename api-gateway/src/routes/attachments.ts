// =============================================================================
// attachments.ts — presigned-URL routes for note/memo attachments (R2).
//
//   POST /attachments/upload-url   — authed. Validates id/mime/size, derives the
//                                    R2 key from JWT.sub (never the client), and
//                                    returns a short-TTL presigned PUT URL. The
//                                    desktop PUTs bytes directly to R2.
//
//   POST /attachments/:id/download-url — PR2 (needs the synced `attachments` row
//                                    for firm-scoped authorization).
//
// The gateway never touches bytes. Fail closed when R2 is unconfigured. The
// attachment metadata row is created on the DESKTOP via the withSync barrel and
// arrives in Neon through the outbox — this route does NOT write any row.
// =============================================================================

import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import {
  presignAttachmentPut,
  attachmentStorageKey,
  isAllowedAttachmentMime,
  isAttachmentStorageConfigured,
  ALLOWED_ATTACHMENT_MIME_TYPES,
} from '../attachments/attachment-storage'

// Client-minted ids are cuid2 (lowercase alphanumeric). Cap length defensively
// so a malformed id can't reach the storage key / future attachments.id column.
// (Same shape guard as recordings' CLIENT_ID_RE.)
const ATTACHMENT_ID_RE = /^[a-z0-9]{1,32}$/

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────────
  // POST /attachments/upload-url  (authed)
  // ───────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/attachments/upload-url',
    schema: {
      body: z.object({
        // The cuid2 the desktop minted for this attachment. Echoed into the key.
        attachmentId: z.string().min(1).max(32),
        contentType: z.string().min(1),
        // Authoritative size check is here (route), mirrored desktop-side for a
        // fast local fail. Must be > 0 (reject empty) and ≤ the cap.
        sizeBytes: z.number().int().positive(),
      }),
      response: {
        200: z.object({
          url: z.string().url(),
          storageKey: z.string(),
          expiresInSeconds: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireUser()

      // Fail closed when R2 isn't configured — never sign against a
      // half-configured client.
      if (!isAttachmentStorageConfigured(env)) {
        throw new GatewayError({
          statusCode: 503,
          code: 'STORAGE_NOT_CONFIGURED',
          message: 'Attachment storage is not configured on this gateway.',
        })
      }

      const { attachmentId, contentType, sizeBytes } = req.body

      // Validate the client-minted id shape before it reaches the storage key.
      if (!ATTACHMENT_ID_RE.test(attachmentId)) {
        throw new GatewayError({
          statusCode: 400,
          code: 'INVALID_ATTACHMENT_ID',
          message: 'attachmentId is not a valid id.',
        })
      }

      // Content-type allowlist (raster images + pdf; no SVG — decision 3A).
      if (!isAllowedAttachmentMime(contentType)) {
        throw new GatewayError({
          statusCode: 400,
          code: 'UNSUPPORTED_MIME_TYPE',
          message: `Unsupported attachment type "${contentType}". Allowed: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}.`,
        })
      }

      // Authoritative size cap.
      if (sizeBytes > env.ATTACHMENT_MAX_UPLOAD_BYTES) {
        throw new GatewayError({
          statusCode: 413,
          code: 'UPLOAD_TOO_LARGE',
          message: `Attachment too large (max ${env.ATTACHMENT_MAX_UPLOAD_BYTES} bytes).`,
        })
      }

      // Key is derived from JWT.sub — NEVER a client-supplied user id (IDOR
      // guard). The presigned PUT is thus scoped to this user's prefix.
      const storageKey = attachmentStorageKey(user.sub, attachmentId)
      const url = await presignAttachmentPut({
        env,
        key: storageKey,
        contentType,
        contentLength: sizeBytes,
      })

      req.log.info(
        {
          attachmentId,
          userId: user.sub,
          sizeBytes,
          contentType,
          metric: 'attachment.presign.issued',
        },
        'attachments.upload-url issued presigned PUT',
      )

      return { url, storageKey, expiresInSeconds: env.ATTACHMENT_PRESIGN_TTL_SECONDS }
    },
  })
}
