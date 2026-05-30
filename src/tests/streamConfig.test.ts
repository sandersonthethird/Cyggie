import { describe, it, expect } from 'vitest'
import { resolveStreamConfig } from '../shared/transcription/streamConfig'

describe('resolveStreamConfig', () => {
  it('returns mono when toggle is off', () => {
    expect(
      resolveStreamConfig({
        separateMicAndSystemTranscription: false,
        provider: 'deepgram',
        platform: 'darwin',
      }),
    ).toEqual({ channels: 1, useAec: false, useDedup: false })
  })

  it('returns stereo when toggle on + Deepgram + darwin', () => {
    expect(
      resolveStreamConfig({
        separateMicAndSystemTranscription: true,
        provider: 'deepgram',
        platform: 'darwin',
      }),
    ).toEqual({ channels: 2, useAec: true, useDedup: true })
  })

  it('returns mono when provider is AssemblyAI even with toggle on', () => {
    // Defensive guard: UI also disables the toggle for AssemblyAI, but
    // this is the structural backstop.
    expect(
      resolveStreamConfig({
        separateMicAndSystemTranscription: true,
        provider: 'assemblyai',
        platform: 'darwin',
      }),
    ).toEqual({ channels: 1, useAec: false, useDedup: false })
  })

  it('returns mono on non-macOS (no CoreAudioTap loopback)', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      expect(
        resolveStreamConfig({
          separateMicAndSystemTranscription: true,
          provider: 'deepgram',
          platform,
        }),
      ).toEqual({ channels: 1, useAec: false, useDedup: false })
    }
  })

  it('returns mono when both provider and platform are wrong', () => {
    expect(
      resolveStreamConfig({
        separateMicAndSystemTranscription: true,
        provider: 'assemblyai',
        platform: 'linux',
      }),
    ).toEqual({ channels: 1, useAec: false, useDedup: false })
  })
})
