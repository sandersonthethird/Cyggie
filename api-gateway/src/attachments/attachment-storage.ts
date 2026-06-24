// =============================================================================
// attachment-storage.ts — Cloudflare R2 presign layer for note/memo attachments.
//
// The gateway NEVER holds attachment bytes. It mints short-TTL, user-scoped,
// size/content-type-constrained presigned URLs; the desktop PUTs/GETs R2
// directly (Apple-Notes / CloudKit-style direct-to-blob). Only small metadata
// rows sync via the outbox — see packages/db owned-tables `attachments`.
//
//   DESKTOP                       GATEWAY                         R2
//   ───────                       ───────                         ──
//   POST /attachments/upload-url ─▶ presignPut(key,type,len) ───▶ signed PUT url
//   PUT bytes ──────────────────────────────────────────────────▶ R2 object
//   GET cyggie-attachment://id ──▶ presignGet(key)  [PR2] ──────▶ signed GET url
//
// FAIL CLOSED: all five R2_* env vars are optional so the gateway boots without
// R2 (parity with APNs/Slack), but every presign call throws
// AttachmentStorageNotConfiguredError when any is missing — the route maps that
// to a 503 with a clear operator message rather than signing against a
// half-configured client.
// =============================================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { GatewayEnv } from '../env'

// Allowlisted attachment content types. Raster images only — NO SVG (inline
// SVG can execute <script> in the Electron renderer; eng-review decision 3A) —
// plus PDF (opened externally via shell.openPath, never rendered inline).
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const

export type AttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number]

export function isAllowedAttachmentMime(mime: string): mime is AttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)
}

export class AttachmentStorageNotConfiguredError extends Error {
  constructor() {
    super(
      'Attachment storage (R2) is not configured. Set R2_ACCOUNT_ID, ' +
        'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_ENDPOINT.',
    )
    this.name = 'AttachmentStorageNotConfiguredError'
  }
}

interface R2Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** True only when every R2_* var the presign client needs is present. */
export function isAttachmentStorageConfigured(env: GatewayEnv): boolean {
  return resolveR2Config(env) !== null
}

function resolveR2Config(env: GatewayEnv): R2Config | null {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return null
  }
  return {
    endpoint: R2_ENDPOINT,
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  }
}

// Lazily-built S3 client, keyed by endpoint+access-key so a config change in a
// long-lived process (unlikely, but cheap to be correct) rebuilds it.
let cachedClient: { key: string; client: S3Client } | null = null

function getS3Client(cfg: R2Config): S3Client {
  const key = `${cfg.endpoint}|${cfg.accessKeyId}`
  if (cachedClient && cachedClient.key === key) return cachedClient.client
  const client = new S3Client({
    // R2 ignores region but the SDK requires one; 'auto' is the documented value.
    region: 'auto',
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  })
  cachedClient = { key, client }
  return client
}

/**
 * Build the canonical R2 object key for an attachment.
 *
 * Keyed by the UPLOADER's user id so a presigned URL is naturally scoped to a
 * single user's prefix. The caller MUST pass a userId derived from JWT.sub —
 * never a client-supplied value (IDOR guard).
 */
export function attachmentStorageKey(userId: string, attachmentId: string): string {
  return `attachments/${userId}/${attachmentId}`
}

/**
 * Mint a presigned PUT URL. The signature pins Content-Type and Content-Length,
 * so the desktop's PUT must send matching headers — R2 rejects a spoofed
 * type/size. TTL from ATTACHMENT_PRESIGN_TTL_SECONDS.
 */
export async function presignAttachmentPut(opts: {
  env: GatewayEnv
  key: string
  contentType: string
  contentLength: number
}): Promise<string> {
  const cfg = resolveR2Config(opts.env)
  if (!cfg) throw new AttachmentStorageNotConfiguredError()
  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: opts.key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  })
  return getSignedUrl(getS3Client(cfg), command, {
    expiresIn: opts.env.ATTACHMENT_PRESIGN_TTL_SECONDS,
  })
}

/**
 * Mint a presigned GET URL. Used by the desktop cyggie-attachment:// protocol
 * handler on a local-cache miss. Authorization (firm-scoped) is the route's job;
 * this only signs. (Wired in PR2 alongside the attachments table.)
 */
export async function presignAttachmentGet(opts: {
  env: GatewayEnv
  key: string
}): Promise<string> {
  const cfg = resolveR2Config(opts.env)
  if (!cfg) throw new AttachmentStorageNotConfiguredError()
  const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: opts.key })
  return getSignedUrl(getS3Client(cfg), command, {
    expiresIn: opts.env.ATTACHMENT_PRESIGN_TTL_SECONDS,
  })
}
