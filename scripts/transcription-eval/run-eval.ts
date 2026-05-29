#!/usr/bin/env node
/* eslint-disable no-console */
// EVAL-FEATURE: CLI for running candidate transcription providers against
// saved meeting audio. Bypasses Electron so it can run from a plain
// terminal via `pnpm eval:transcription`.
//
// Usage:
//   pnpm eval:transcription -- --meeting=<id> --providers=deepgram_batch,assemblyai_universal3
//   pnpm eval:transcription -- --audio=./fixture.m4a --providers=assemblyai_universal3
//   pnpm eval:transcription -- --help
//
// API keys are sourced from (in priority order):
//   1. Env vars: DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY
//   2. Desktop SQLite settings table (dev mode stores plaintext;
//      packaged-build keys won't decrypt here — set via env instead)

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join, basename } from 'path'
import { DeepgramBatchAdapter } from '../../src/main/transcription-eval/adapters/deepgram-batch.adapter'
import { AssemblyAiAdapter } from '../../src/main/transcription-eval/adapters/assemblyai.adapter'
import type {
  EvalProvider,
  TranscribeResult,
  TranscriptionProvider,
} from '../../src/main/transcription-eval/adapters/types'

interface CliArgs {
  meetings: string[]
  audio: string | null
  providers: EvalProvider[]
  outDir: string
  help: boolean
}

const ALL_PROVIDERS: EvalProvider[] = ['deepgram_batch', 'assemblyai_universal3']

function defaultStoragePath(): string {
  // Mirrors src/main/storage/paths.ts → getDefaultStoragePath() on macOS.
  // Override via CYGGIE_STORAGE_PATH env var.
  const override = process.env['CYGGIE_STORAGE_PATH']
  if (override) return override
  return join(homedir(), 'Documents', 'MeetingIntelligence')
}

// Exported for the smoke test in src/tests/transcription-eval-cli.test.ts.
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    meetings: [],
    audio: null,
    providers: [...ALL_PROVIDERS],
    outDir: '',
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('--meeting=')) args.meetings.push(a.slice('--meeting='.length))
    else if (a.startsWith('--audio=')) args.audio = a.slice('--audio='.length)
    else if (a.startsWith('--providers=')) {
      const raw = a.slice('--providers='.length)
      args.providers = raw.split(',').map((s) => s.trim()) as EvalProvider[]
    } else if (a.startsWith('--out=')) args.outDir = a.slice('--out='.length)
  }
  return args
}

function printHelp(): void {
  console.log(`
Cyggie transcription provider eval

Usage:
  pnpm eval:transcription -- --meeting=<id> [--meeting=<id> ...] [--providers=<list>]
  pnpm eval:transcription -- --audio=<path> [--providers=<list>]
  pnpm eval:transcription -- --help

Options:
  --meeting=<id>       Meeting id whose <id>.m4a lives in <recordingsDir>.
                       Repeatable.
  --audio=<path>       Ad-hoc audio file (.m4a / .wav / .mp3). Skips DB lookup.
  --providers=<list>   Comma-separated. One or more of:
                         ${ALL_PROVIDERS.join(', ')}
                       Default: all three.
  --out=<dir>          Directory to write the markdown summary + sidecar JSON.
                       Default: <recordingsDir>/eval-results/

Environment:
  CYGGIE_STORAGE_PATH  Override the default ~/Documents/MeetingIntelligence
                       path. Useful when running against a non-default profile.
  DEEPGRAM_API_KEY     Override key resolved from SQLite settings.
  ASSEMBLYAI_API_KEY   Override key resolved from SQLite settings.
`)
}

function readApiKey(
  db: Database.Database | null,
  settingsKey: string,
  envVar: string,
): string | null {
  const fromEnv = process.env[envVar]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  if (!db) return null
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey) as
      | { value: string }
      | undefined
    return row?.value?.trim() || null
  } catch {
    return null
  }
}

function buildProvider(id: EvalProvider, db: Database.Database | null): TranscriptionProvider | null {
  if (id === 'deepgram_batch') {
    const key = readApiKey(db, 'deepgramApiKey', 'DEEPGRAM_API_KEY')
    if (!key) {
      console.warn('[eval] deepgram_batch: no API key configured (settings or env)')
      return null
    }
    return new DeepgramBatchAdapter(key)
  }
  if (id === 'assemblyai_universal3') {
    const key = readApiKey(db, 'assemblyaiApiKey', 'ASSEMBLYAI_API_KEY')
    if (!key) {
      console.warn('[eval] assemblyai_universal3: no API key configured (settings or env)')
      return null
    }
    return new AssemblyAiAdapter(key)
  }
  console.warn(`[eval] unknown provider id: ${id}`)
  return null
}

interface EvalRow {
  audioLabel: string
  audioPath: string
  results: Map<EvalProvider, { result?: TranscribeResult; error?: string }>
}

async function runOneAudio(
  audioPath: string,
  label: string,
  providers: TranscriptionProvider[],
): Promise<EvalRow> {
  const results = new Map<EvalProvider, { result?: TranscribeResult; error?: string }>()
  // Sequential — within a single audio file we don't gain from concurrency
  // and we avoid double-hitting the same provider when batching multiple
  // meetings. Cross-audio parallelism is a future tweak if needed.
  for (const provider of providers) {
    console.log(`[eval] ${label} × ${provider.id}: running...`)
    try {
      const result = await provider.transcribe(audioPath, {})
      results.set(provider.id, { result })
      console.log(
        `[eval] ${label} × ${provider.id}: ok in ${result.latencyMs}ms (${result.segments.length} segments)`,
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      results.set(provider.id, { error })
      console.warn(`[eval] ${label} × ${provider.id}: FAILED — ${error}`)
    }
  }
  return { audioLabel: label, audioPath, results }
}

function renderMarkdown(rows: EvalRow[], providers: TranscriptionProvider[]): string {
  const lines: string[] = []
  lines.push('# Transcription provider evaluation')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  for (const row of rows) {
    lines.push(`## ${row.audioLabel}`)
    lines.push('')
    lines.push(`Audio: \`${row.audioPath}\``)
    lines.push('')
    lines.push('| Provider | Status | Latency | Diarization | Audio (s) | $ est. | Text excerpt |')
    lines.push('|----------|--------|---------|-------------|-----------|--------|--------------|')
    for (const p of providers) {
      const entry = row.results.get(p.id)
      if (!entry) {
        lines.push(`| ${p.displayName} | _not run_ | — | — | — | — | — |`)
        continue
      }
      if (entry.error) {
        lines.push(
          `| ${p.displayName} | ❌ failed | — | — | — | — | ${escapeMd(entry.error.slice(0, 120))} |`,
        )
        continue
      }
      const r = entry.result!
      const excerpt = r.text.slice(0, 160).replace(/\s+/g, ' ')
      const cost = r.estimatedCostUsd !== null ? `$${r.estimatedCostUsd.toFixed(3)}` : '—'
      const dur = r.audioDurationSeconds !== null ? `${r.audioDurationSeconds.toFixed(1)}` : '—'
      lines.push(
        `| ${p.displayName} | ✅ ok | ${r.latencyMs}ms | ${r.diarization} | ${dur} | ${cost} | ${escapeMd(excerpt)} |`,
      )
    }
    lines.push('')
    // Full text dump per provider for side-by-side comparison.
    for (const p of providers) {
      const entry = row.results.get(p.id)
      if (!entry?.result) continue
      lines.push(`### ${p.displayName} — full transcript`)
      lines.push('')
      lines.push('```')
      lines.push(entry.result.text || '(empty)')
      lines.push('```')
      lines.push('')
    }
  }
  return lines.join('\n')
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const validProviders = args.providers.filter((p) => ALL_PROVIDERS.includes(p))
  if (validProviders.length === 0) {
    console.error('[eval] No valid providers specified.')
    printHelp()
    process.exit(1)
  }

  const storagePath = defaultStoragePath()
  const recordingsDir = join(storagePath, 'recordings')
  // Database is optional — env vars take priority. If better-sqlite3 fails
  // to load (e.g. it was rebuilt for Electron and we're running under plain
  // Node), fall through to env-var-only mode. The CLI exits with a clear
  // error later if no keys are configured anywhere.
  let db: Database.Database | null = null
  const dbPath = join(storagePath, 'echovault.db')
  if (existsSync(dbPath)) {
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[eval] Could not open ${dbPath} (${msg.split('\n')[0]}). Falling back to env vars only.`,
      )
    }
  }

  const adapters = validProviders
    .map((id) => buildProvider(id, db))
    .filter((a): a is TranscriptionProvider => a !== null)

  if (adapters.length === 0) {
    console.error('[eval] No usable providers (missing keys). Configure keys in Settings or env.')
    process.exit(1)
  }

  const outDir = args.outDir || join(recordingsDir, 'eval-results')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const rows: EvalRow[] = []

  if (args.audio) {
    const audioPath = args.audio
    if (!existsSync(audioPath)) {
      console.error(`[eval] Audio file not found: ${audioPath}`)
      process.exit(1)
    }
    rows.push(await runOneAudio(audioPath, basename(audioPath), adapters))
  } else if (args.meetings.length > 0) {
    for (const meetingId of args.meetings) {
      const audioPath = join(recordingsDir, `${meetingId}.m4a`)
      if (!existsSync(audioPath)) {
        console.warn(`[eval] No audio for meeting ${meetingId} at ${audioPath} — skipping`)
        continue
      }
      rows.push(await runOneAudio(audioPath, meetingId, adapters))

      // Write per-provider sidecar JSON next to the audio.
      const lastRow = rows[rows.length - 1]
      for (const [providerId, entry] of lastRow.results) {
        if (!entry.result) continue
        const sidecar = join(recordingsDir, `${meetingId}.${providerId}.json`)
        await writeFile(sidecar, JSON.stringify(entry.result.segments, null, 2), 'utf-8')
      }
    }
  } else {
    console.error('[eval] Provide --meeting=<id> or --audio=<path>')
    printHelp()
    process.exit(1)
  }

  if (rows.length === 0) {
    console.error('[eval] No audio files were processed.')
    process.exit(1)
  }

  const markdown = renderMarkdown(rows, adapters)
  const outPath = join(outDir, `eval-${Date.now()}.md`)
  await writeFile(outPath, markdown, 'utf-8')
  console.log(`\n[eval] Wrote ${outPath}`)
  console.log('\n' + markdown)
}

// Only invoke main() when this file is the CLI entry point, not when it's
// imported by a test or other module. We check whether process.argv[1]
// resolves to this file's path; under tsx that's the path passed on the
// command line.
function isCliEntry(): boolean {
  const entry = process.argv[1] ?? ''
  return entry.endsWith('/run-eval.ts') || entry.endsWith('\\run-eval.ts')
}

if (isCliEntry()) {
  main().catch((err) => {
    console.error('[eval] Fatal:', err)
    process.exit(1)
  })
}

// Re-export readFile so the bundler keeps it in scope when tsx runs this
// (mainly defensive — readFile is used by the adapters but our entry is
// CLI, so the static analyzer occasionally tree-shakes too aggressively).
export { readFile }
