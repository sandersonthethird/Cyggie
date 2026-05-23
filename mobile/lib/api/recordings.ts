// =============================================================================
// recordings.ts — mobile-side wrappers for the M3 recording endpoints.
//
//   uploadRecording          — multipart POST to /recordings/upload.
//                              Uses expo-file-system.uploadAsync so the
//                              upload survives short backgrounding and we
//                              get progress events for the UI.
//   registerPushToken        — POST /devices/register-push with the APNs
//                              device token (called once after auth status
//                              transitions to signed_in).
//
// We don't use apiFetch() for the upload because it serializes everything as
// JSON; multipart audio needs the native upload path. registerPushToken IS
// JSON, so it routes through the normal api.post().
// =============================================================================

// expo-file-system v19 moved the upload-task API under /legacy. The new
// top-level File class doesn't have a direct upload helper yet, and the
// legacy createUploadTask is still fully supported in SDK 54.
import * as FileSystem from 'expo-file-system/legacy'
import { api, ApiError, ensureFreshAccessToken } from './client'
import { useAuthStore } from '../auth/store'

// Read directly from process.env so Metro inlines this at JS-bundle time —
// changing mobile/.env + a Metro reload picks up the new value. Reading from
// Constants.expoConfig.extra requires a native rebuild (the manifest is
// baked at expo prebuild / pnpm ios time), which is too slow for dev.
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export interface UploadRecordingArgs {
  /** Absolute file:// URI of the recorded audio on the device. */
  localUri: string
  title?: string
  calEventId?: string
  /** ISO timestamp of when recording started on the device. */
  clientRecordedAt?: string
  /** 0–1; called on every progress event. */
  onProgress?: (fraction: number) => void
}

export interface UploadRecordingResult {
  meetingId: string
}

// =============================================================================
// uploadRecording — 401 → refresh → retry shape.
//
// Mirrors the canonical pattern from commit 742bb69
// (src/main/services/gateway-credentials.ts → pushAnthropicKey). The
// JS apiFetch helper has the same shape, but we can't reuse it directly
// because createUploadTask is a native transport (background-friendly,
// progress events) — its 401 surfaces as a non-throwing
// result.status===401 instead of an exception, so the wrapper has to
// inspect the response code itself.
//
//   ┌─ first tryOnce (cached token) ────────────────────────────────┐
//   │  2xx                       → return                            │
//   │  401 + reauth_required:true → throw (no point refreshing)      │
//   │  401 (refreshable)          → ensureFreshAccessToken()         │
//   │                                  ↓                             │
//   │                          null? → throw (refresh failed)        │
//   │                          fresh → second tryOnce(fresh)         │
//   │                                  ↓                             │
//   │                          2xx → return                          │
//   │                          401/etc → throw                       │
//   │  any other status           → throw                            │
//   └────────────────────────────────────────────────────────────────┘
//
// The catch in performUpload (recording/session.ts) persists the audio
// + metadata to MMKV on throw, so an auth failure here never loses the
// recording — the user can retry after re-signin (the on-signin
// redirect in _layout.tsx routes them straight to the retry banner).
// =============================================================================
export async function uploadRecording(args: UploadRecordingArgs): Promise<UploadRecordingResult> {
  const initialToken = useAuthStore.getState().accessToken
  if (!initialToken) {
    throw new ApiError({
      status: 401,
      code: 'NOT_SIGNED_IN',
      message: 'Sign in before recording.',
    })
  }

  const parameters: Record<string, string> = {}
  if (args.title) parameters['title'] = args.title
  if (args.calEventId) parameters['calEventId'] = args.calEventId
  if (args.clientRecordedAt) parameters['clientRecordedAt'] = args.clientRecordedAt

  type UploadResult = Awaited<ReturnType<ReturnType<typeof FileSystem.createUploadTask>['uploadAsync']>>

  // createUploadTask is rebuilt per attempt so the Authorization header
  // closes over the live token. Progress callback is shared — the
  // second attempt picks up where the first left off (status flips
  // back to 0% on resend, which is the correct UX).
  const tryOnce = async (token: string): Promise<UploadResult> => {
    const task = FileSystem.createUploadTask(
      `${GATEWAY_URL}/recordings/upload`,
      args.localUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'audio',
        // expo-av's IOSOutputFormat.MPEG4AAC writes an M4A container (with AAC
        // codec inside) — not a raw .aac stream. mimeType must match for
        // Deepgram's container detection to work downstream.
        mimeType: 'audio/mp4',
        parameters,
        headers: { Authorization: `Bearer ${token}` },
      },
      (progress) => {
        if (progress.totalBytesExpectedToSend > 0) {
          args.onProgress?.(
            progress.totalBytesSent / progress.totalBytesExpectedToSend,
          )
        }
      },
    )
    return task.uploadAsync()
  }

  type GatewayErr = { error?: { code?: string; message?: string }; reauth_required?: boolean }
  const parseBody = (raw: string | undefined): GatewayErr => {
    if (!raw) return {}
    try {
      return JSON.parse(raw) as GatewayErr
    } catch {
      return {}
    }
  }

  let result = await tryOnce(initialToken)
  if (result && result.status === 401) {
    const body = parseBody(result.body)
    if (!body.reauth_required) {
      // Stale token — try one refresh and retry once. Matches
      // gateway-credentials.ts (commit 742bb69) verbatim.
      const fresh = await ensureFreshAccessToken()
      if (fresh) {
        result = await tryOnce(fresh)
      }
    }
  }

  if (!result) {
    throw new ApiError({ status: 0, code: 'UPLOAD_FAILED', message: 'Upload did not complete.' })
  }
  if (result.status < 200 || result.status >= 300) {
    const body = parseBody(result.body)
    throw new ApiError({
      status: result.status,
      code: body.error?.code ?? `HTTP_${result.status}`,
      message: body.error?.message ?? `Upload failed (${result.status})`,
      reauthRequired: body.reauth_required === true,
    })
  }
  return JSON.parse(result.body) as UploadRecordingResult
}

export interface RegisterPushTokenArgs {
  deviceToken: string
  environment: 'sandbox' | 'production'
}

export async function registerPushToken(args: RegisterPushTokenArgs): Promise<void> {
  await api.post<{ ok: true }, RegisterPushTokenArgs>('/devices/register-push', args)
}
