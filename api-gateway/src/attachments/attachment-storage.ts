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
      'Attachment storage is not configured. Set the Fly Tigris vars ' +
        '(AWS_ENDPOINT_URL_S3, BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) ' +
        'or the R2_* equivalents.',
    )
    this.name = 'AttachmentStorageNotConfiguredError'
  }
}

interface StorageConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

/** True only when the S3-compatible storage client can be fully configured. */
export function isAttachmentStorageConfigured(env: GatewayEnv): boolean {
  return resolveStorageConfig(env) !== null
}

/**
 * Resolve the S3-compatible storage config. Prefers the S3-standard vars that
 * Fly Tigris sets automatically (AWS_ENDPOINT_URL_S3 / BUCKET_NAME / AWS_*),
 * falling back to the R2_* names. Tigris and Cloudflare R2 are both S3 v4
 * compatible, so the same @aws-sdk client + presigner drives either.
 */
function resolveStorageConfig(env: GatewayEnv): StorageConfig | null {
  const endpoint = env.AWS_ENDPOINT_URL_S3 ?? env.R2_ENDPOINT
  const bucket = env.BUCKET_NAME ?? env.R2_BUCKET
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? env.R2_SECRET_ACCESS_KEY
  // Tigris/R2 ignore region but the SDK requires one; 'auto' is the documented value.
  const region = env.AWS_REGION ?? 'auto'
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return { endpoint, bucket, accessKeyId, secretAccessKey, region }
}

// Lazily-built S3 client, keyed by endpoint+access-key so a config change in a
// long-lived process (unlikely, but cheap to be correct) rebuilds it.
let cachedClient: { key: string; client: S3Client } | null = null

function getS3Client(cfg: StorageConfig): S3Client {
  const key = `${cfg.endpoint}|${cfg.accessKeyId}`
  if (cachedClient && cachedClient.key === key) return cachedClient.client
  const client = new S3Client({
    region: cfg.region,
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
 * Mint a presigned PUT URL. Signs only Content-Type (NOT Content-Length): a
 * signed content-length is the most fragile part of the PUT handshake (the
 * client must echo it exactly), so we drop it to minimize first-upload 403s.
 * Size is already capped in the route (pre-sign validation) and desktop-side
 * (bytes.length before PUT). `contentLength` is accepted for API symmetry but
 * intentionally not signed. TTL from ATTACHMENT_PRESIGN_TTL_SECONDS.
 */
export async function presignAttachmentPut(opts: {
  env: GatewayEnv
  key: string
  contentType: string
  contentLength: number
}): Promise<string> {
  const cfg = resolveStorageConfig(opts.env)
  if (!cfg) throw new AttachmentStorageNotConfiguredError()
  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: opts.key,
    ContentType: opts.contentType,
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
  const cfg = resolveStorageConfig(opts.env)
  if (!cfg) throw new AttachmentStorageNotConfiguredError()
  const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: opts.key })
  return getSignedUrl(getS3Client(cfg), command, {
    expiresIn: opts.env.ATTACHMENT_PRESIGN_TTL_SECONDS,
  })
}
