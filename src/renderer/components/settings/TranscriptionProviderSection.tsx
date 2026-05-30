import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

/**
 * Live transcription provider picker. Two radio buttons that drive the
 * `liveTranscriptionProvider` setting; locked at recording start (mid-call
 * changes apply to the NEXT recording).
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Live transcription provider (liveTranscriptionProvider):     │
 *   │    • "deepgram" (default) — Deepgram nova-3 streaming         │
 *   │    • "assemblyai"          — AssemblyAI Universal-Streaming v3 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Also exposes the developer-facing `saveAudioForEval` toggle inside a
 * collapsed "Developer / Eval" disclosure. Off by default; when on, every
 * recording writes a parallel AAC file (~50 MB/hour) so the eval CLI can
 * re-run alternate providers against the same audio.
 */

type Provider = 'deepgram' | 'assemblyai'

const PROVIDER_KEY = 'liveTranscriptionProvider'
const SAVE_AUDIO_KEY = 'saveAudioForEval'
const SEPARATE_STREAMS_KEY = 'separateMicAndSystemTranscription'

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

export function TranscriptionProviderSection() {
  const [provider, setProvider] = useState<Provider>('deepgram')
  const [saveAudio, setSaveAudio] = useState(false)
  const [separateStreams, setSeparateStreams] = useState(false)
  const [showDevDetails, setShowDevDetails] = useState(false)

  // Toggle is only meaningful with Deepgram on macOS. UI guard plus the
  // structural backstop in `resolveStreamConfig` — both flips force mono.
  const separateStreamsDisabled = provider !== 'deepgram' || !IS_MAC
  const effectiveSeparateStreams = separateStreams && !separateStreamsDisabled

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL)
      if (cancelled) return
      const raw = all[PROVIDER_KEY]
      setProvider(raw === 'assemblyai' ? 'assemblyai' : 'deepgram')
      setSaveAudio(all[SAVE_AUDIO_KEY] === 'true')
      setSeparateStreams(all[SEPARATE_STREAMS_KEY] === 'true')
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  async function commitProvider(value: Provider) {
    setProvider(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, PROVIDER_KEY, value)
  }

  async function commitSaveAudio(value: boolean) {
    setSaveAudio(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, SAVE_AUDIO_KEY, value ? 'true' : 'false')
  }

  async function commitSeparateStreams(value: boolean) {
    setSeparateStreams(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, SEPARATE_STREAMS_KEY, value ? 'true' : 'false')
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ minWidth: 180, fontSize: 13 }}>Live provider</span>
          <span style={{ display: 'flex', gap: 16, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="live-transcription-provider"
                value="deepgram"
                checked={provider === 'deepgram'}
                onChange={() => commitProvider('deepgram')}
              />
              Deepgram nova-3 (default)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="live-transcription-provider"
                value="assemblyai"
                checked={provider === 'assemblyai'}
                onChange={() => commitProvider('assemblyai')}
              />
              AssemblyAI Universal-Streaming
            </label>
          </span>
        </label>
        <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
          Changes apply to the next recording. The other provider is used as
          a silent fallback if the chosen one fails to connect.
        </p>
      </div>

      <div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            opacity: separateStreamsDisabled ? 0.5 : 1,
          }}
        >
          <span style={{ minWidth: 180, fontSize: 13 }}>Speaker attribution</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={effectiveSeparateStreams}
              disabled={separateStreamsDisabled}
              onChange={(e) => commitSeparateStreams(e.target.checked)}
            />
            Separate transcription for you and others
          </span>
        </label>
        <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
          {separateStreamsDisabled
            ? !IS_MAC
              ? 'Available on macOS only.'
              : 'Available with Deepgram only.'
            : 'Sends your mic and the meeting audio as two streams. Improves speaker attribution. Takes effect on next recording.'}
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowDevDetails((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--color-text-secondary, #6b7280)',
            fontSize: 11,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {showDevDetails ? '▼' : '▶'} Developer / Eval
        </button>
        {showDevDetails && (
          <div style={{ marginTop: 8, marginLeft: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={saveAudio}
                onChange={(e) => commitSaveAudio(e.target.checked)}
              />
              Save recorded audio for offline eval
            </label>
            <p style={{ marginTop: 2, marginLeft: 22, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
              When on, every recording writes a parallel AAC file
              (~50&nbsp;MB/hour) to the recordings directory. Used by{' '}
              <code>pnpm eval:transcription</code> to compare providers offline.
              Off by default.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
