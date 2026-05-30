// Streaming transcriber factory + bidirectional auto-fallback.
//
// RecordingSession asks for a StreamingTranscriber given the user's chosen
// provider; the factory builds the correct client and connects it. If the
// chosen provider's connect fails within FALLBACK_TIMEOUT_MS AND the
// other provider's API key is configured, the factory silently switches
// to the other provider and emits a 'fallback' event so the caller can
// surface a banner.
//
// Decision tree:
//
//   chosen provider connect →
//     │
//     ├─ succeeds within 5s → return that client, no fallback
//     │
//     ├─ fails or times out →
//     │     │
//     │     ├─ other provider's key configured → fallback to other
//     │     │       │
//     │     │       ├─ succeeds → return other client, emit fallback event
//     │     │       └─ fails    → throw (both providers down)
//     │     │
//     │     └─ other key NOT configured → throw (chosen failed, no fallback)
//
// Both providers' keys must be in the SQLite settings (deepgramApiKey and
// assemblyaiApiKey). The caller passes both via the keyResolver function;
// the factory only invokes resolution lazily for the fallback path.

import { DeepgramStreamingClient } from '../deepgram/client'
import { AssemblyAiStreamingClient } from './assemblyai-streaming-client'
import type {
  StreamingTranscriber,
  StreamingTranscriberConfig,
  TranscriptionProvider,
} from './types'

const FALLBACK_TIMEOUT_MS = 5000

export interface FactoryResult {
  client: StreamingTranscriber
  /**
   * Set when the chosen provider's connect failed and we fell back to the
   * other provider. The caller (RecordingSession) should surface a banner
   * "Using <activeProvider> — <originalProvider> unreachable."
   */
  fallback?: {
    originalProvider: TranscriptionProvider
    reason: string
  }
}

export interface FactoryOptions {
  chosenProvider: TranscriptionProvider
  /**
   * Synchronous key lookup. Returns the configured API key for a provider,
   * or null if the user hasn't configured one. Pure data, no IPC.
   */
  resolveApiKey: (provider: TranscriptionProvider) => string | null
  /** Vocabulary biasing terms forwarded to whichever client is built. */
  keyterms?: string[]
  maxSpeakers?: number
  /**
   * Channel count from `resolveStreamConfig`. Only meaningful for
   * Deepgram (`channels: 2` → multichannel mode). AssemblyAI ignores.
   */
  channels?: number
}

function buildClient(
  provider: TranscriptionProvider,
  config: StreamingTranscriberConfig,
): StreamingTranscriber {
  if (provider === 'deepgram') {
    return new DeepgramStreamingClient({
      apiKey: config.apiKey,
      keyterms: config.keyterms,
      maxSpeakers: config.maxSpeakers,
      channels: config.channels ?? 1,
    })
  }
  if (provider === 'assemblyai') {
    return new AssemblyAiStreamingClient({
      apiKey: config.apiKey,
      keyterms: config.keyterms,
      maxSpeakers: config.maxSpeakers,
    })
  }
  // Defensive: TypeScript guarantees coverage, but the corrupted-setting
  // case (DB rewritten by hand, value drift across versions) falls through
  // here. Throwing is preferable to silently defaulting.
  throw new Error(`Unknown transcription provider: ${String(provider)}`)
}

function otherProvider(p: TranscriptionProvider): TranscriptionProvider {
  return p === 'deepgram' ? 'assemblyai' : 'deepgram'
}

async function connectWithTimeout(
  client: StreamingTranscriber,
  timeoutMs: number,
): Promise<void> {
  // Attach a no-op 'error' listener during connect so EventEmitter's
  // "throws-when-no-listener-on-error" semantics don't crash us before
  // the caller (RecordingSession) attaches its real error handler. The
  // connect promise still rejects on error via the underlying client.
  const noopErrorListener = (): void => {}
  client.on('error', noopErrorListener)

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`connect() did not resolve within ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    await Promise.race([client.connect(), timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
    client.off('error', noopErrorListener)
  }
}

/**
 * Build and connect a StreamingTranscriber. Implements the bidirectional
 * fallback policy from the 2026-05-28 CEO review.
 */
export async function createStreamingTranscriber(
  options: FactoryOptions,
): Promise<FactoryResult> {
  const { chosenProvider, resolveApiKey, keyterms, maxSpeakers, channels } = options

  const chosenKey = resolveApiKey(chosenProvider)
  if (!chosenKey) {
    // Chosen provider has no key. Before failing, see if we can fall
    // back to the other provider — the user may have configured only
    // one key and toggled the picker by mistake.
    const fallbackKey = resolveApiKey(otherProvider(chosenProvider))
    if (!fallbackKey) {
      throw new Error(
        `No API key configured for ${chosenProvider}; fallback ${otherProvider(chosenProvider)} also unconfigured`,
      )
    }
    const fallbackClient = buildClient(otherProvider(chosenProvider), {
      apiKey: fallbackKey,
      keyterms,
      maxSpeakers,
      channels,
    })
    await connectWithTimeout(fallbackClient, FALLBACK_TIMEOUT_MS)
    return {
      client: fallbackClient,
      fallback: {
        originalProvider: chosenProvider,
        reason: `No API key configured for ${chosenProvider}`,
      },
    }
  }

  const chosenClient = buildClient(chosenProvider, {
    apiKey: chosenKey,
    keyterms,
    maxSpeakers,
    channels,
  })
  try {
    await connectWithTimeout(chosenClient, FALLBACK_TIMEOUT_MS)
    return { client: chosenClient }
  } catch (chosenErr) {
    // Chosen provider failed. Try the other one IF its key is configured.
    void chosenClient.close().catch(() => {})
    const otherKey = resolveApiKey(otherProvider(chosenProvider))
    if (!otherKey) {
      throw chosenErr
    }
    const fallbackClient = buildClient(otherProvider(chosenProvider), {
      apiKey: otherKey,
      keyterms,
      maxSpeakers,
      channels,
    })
    try {
      await connectWithTimeout(fallbackClient, FALLBACK_TIMEOUT_MS)
    } catch (fallbackErr) {
      // Both providers down. Surface the original (chosen) failure since
      // that's the one the user wants to debug; the fallback failure is
      // best-effort and may not signal anything actionable.
      void fallbackClient.close().catch(() => {})
      throw chosenErr instanceof Error
        ? chosenErr
        : new Error(`Both providers failed: ${String(chosenErr)} / ${String(fallbackErr)}`)
    }
    const reason = chosenErr instanceof Error ? chosenErr.message : String(chosenErr)
    console.warn(
      `[transcription-factory] Fell back from ${chosenProvider} to ${otherProvider(chosenProvider)}: ${reason}`,
    )
    return {
      client: fallbackClient,
      fallback: {
        originalProvider: chosenProvider,
        reason,
      },
    }
  }
}
