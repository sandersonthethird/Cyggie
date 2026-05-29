// EVAL-FEATURE: smoke test for the eval CLI's argument parsing.
//
// Spawning the actual binary requires a real SQLite db + real ffmpeg, so we
// only exercise the pure parseArgs function. End-to-end smoke is documented
// in scripts/transcription-eval/README.md and verified manually.

import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../scripts/transcription-eval/run-eval'

describe('eval CLI parseArgs', () => {
  it('shows help when --help is passed', () => {
    const args = parseArgs(['--help'])
    expect(args.help).toBe(true)
  })

  it('accepts repeated --meeting flags', () => {
    const args = parseArgs(['--meeting=abc', '--meeting=def'])
    expect(args.meetings).toEqual(['abc', 'def'])
  })

  it('parses --providers as comma-separated list', () => {
    const args = parseArgs(['--providers=deepgram_batch,assemblyai_universal3'])
    expect(args.providers).toEqual(['deepgram_batch', 'assemblyai_universal3'])
  })

  it('defaults to all surviving providers when none specified', () => {
    const args = parseArgs([])
    expect(args.providers).toEqual(['deepgram_batch', 'assemblyai_universal3'])
  })

  it('accepts --audio for ad-hoc files', () => {
    const args = parseArgs(['--audio=/tmp/test.m4a', '--providers=assemblyai_universal3'])
    expect(args.audio).toBe('/tmp/test.m4a')
    expect(args.providers).toEqual(['assemblyai_universal3'])
  })

  it('accepts --out for the markdown output dir', () => {
    const args = parseArgs(['--out=/tmp/results'])
    expect(args.outDir).toBe('/tmp/results')
  })
})
