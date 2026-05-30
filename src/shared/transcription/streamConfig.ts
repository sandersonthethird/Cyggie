import type { LiveTranscriptionProvider } from '../types/settings'

/**
 * Pure function: given the user setting + the runtime context (active
 * provider, current platform), returns the concrete audio + transcriber
 * configuration the recording session should use.
 *
 * Used by both renderer (worklet construction, AEC flag) and main
 * (Deepgram channel count, dedup activation). Living in `src/shared/`
 * avoids duplicating the provider/platform guards in 4 places.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  separateMicAndSystemTranscription === true                │
 *   │  + provider === 'deepgram'                                 │
 *   │  + platform === 'darwin'                                   │
 *   │  → { channels: 2, useAec: true, useDedup: true }           │
 *   │                                                            │
 *   │  any guard fails  → { channels: 1, useAec: false,          │
 *   │                       useDedup: false } (existing mono)    │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The toggle is also disabled at the UI layer in those non-supported
 * cases, but this function's defensive return is the structural guarantee
 * that the audio pipeline never gets into an inconsistent state.
 */
export interface StreamConfig {
  channels: 1 | 2
  useAec: boolean
  useDedup: boolean
}

export interface ResolveStreamConfigArgs {
  separateMicAndSystemTranscription: boolean
  provider: LiveTranscriptionProvider
  platform: NodeJS.Platform | string
}

const MONO_CONFIG: StreamConfig = { channels: 1, useAec: false, useDedup: false }
const STEREO_CONFIG: StreamConfig = { channels: 2, useAec: true, useDedup: true }

export function resolveStreamConfig(args: ResolveStreamConfigArgs): StreamConfig {
  if (!args.separateMicAndSystemTranscription) return MONO_CONFIG
  if (args.provider !== 'deepgram') return MONO_CONFIG
  if (args.platform !== 'darwin') return MONO_CONFIG
  return STEREO_CONFIG
}
