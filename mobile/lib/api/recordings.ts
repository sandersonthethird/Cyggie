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
import { api, ApiError } from './client'
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

export async function uploadRecording(args: UploadRecordingArgs): Promise<UploadRecordingResult> {
  const accessToken = useAuthStore.getState().accessToken
  if (!accessToken) {
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

  // createUploadTask gives progress; uploadAsync is the one-shot equivalent.
  // We want progress for the UI bar so we go with the task variant.
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
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    (progress) => {
      if (progress.totalBytesExpectedToSend > 0) {
        args.onProgress?.(
          progress.totalBytesSent / progress.totalBytesExpectedToSend,
        )
      }
    },
  )
  const result = await task.uploadAsync()
  if (!result) {
    throw new ApiError({ status: 0, code: 'UPLOAD_FAILED', message: 'Upload did not complete.' })
  }
  if (result.status < 200 || result.status >= 300) {
    // Gateway error envelope is { error: { code, message } }
    type GatewayErr = { error?: { code?: string; message?: string }; reauth_required?: boolean }
    let body: GatewayErr = {}
    try {
      body = JSON.parse(result.body) as GatewayErr
    } catch {
      // non-JSON; leave defaults
    }
    throw new ApiError({
      status: result.status,
      code: body.error?.code ?? `HTTP_${result.status}`,
      message: body.error?.message ?? `Upload failed (${result.status})`,
      reauthRequired: body.reauth_required === true,
    })
  }
  const body = JSON.parse(result.body) as UploadRecordingResult
  return body
}

export interface RegisterPushTokenArgs {
  deviceToken: string
  environment: 'sandbox' | 'production'
}

export async function registerPushToken(args: RegisterPushTokenArgs): Promise<void> {
  await api.post<{ ok: true }, RegisterPushTokenArgs>('/devices/register-push', args)
}
