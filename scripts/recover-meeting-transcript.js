#!/usr/bin/env node

/**
 * Manually attach a transcript to a meeting that got stuck in `status='recording'`
 * because the stop-recording flow never completed (e.g. another app co-opted the
 * audio stream and Cyggie didn't surface the stall).
 *
 * Writes the transcript file into the same directory the live app uses and
 * updates the `meetings` row to point at it and flip status to `transcribed`.
 *
 * IMPORTANT: Quit Cyggie before running, then restart it. The main process
 * keeps `currentMeetingId` in memory for the active recording; a stale value
 * will throw "Not recording" the next time you try to stop a real recording.
 *
 * Usage:
 *   node scripts/recover-meeting-transcript.js \
 *     --meeting <meeting-id> \
 *     --input <path/to/transcript.txt|.md> \
 *     [--db <path/to/echovault.db>] \
 *     [--storage <path/to/storage/root>] \
 *     [--duration <seconds>] \
 *     [--dry-run]
 *
 * Uses the `sqlite3` CLI (not better-sqlite3) so it works with system Node.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

function printUsage() {
  console.log(
    'Usage: node scripts/recover-meeting-transcript.js --meeting <id> --input <file> ' +
      '[--db <path>] [--storage <path>] [--duration <seconds>] [--dry-run]'
  )
}

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--meeting') out.meeting = argv[++i]
    else if (a === '--input') out.input = argv[++i]
    else if (a === '--db') out.db = argv[++i]
    else if (a === '--storage') out.storage = argv[++i]
    else if (a === '--duration') out.duration = parseInt(argv[++i], 10)
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}`)
      printUsage()
      process.exit(2)
    }
  }
  return out
}

function defaultDbPath() {
  return path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')
}

function sqliteQuery(dbPath, sql) {
  const result = spawnSync(
    'sqlite3',
    ['-cmd', '.mode tabs', '-cmd', '.headers off', dbPath, sql],
    { encoding: 'utf-8' }
  )
  if (result.status !== 0) {
    throw new Error(`sqlite3 query failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function sqliteRun(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`sqlite3 update failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''")
}

function resolveStoragePath(dbPath, override) {
  if (override) return override
  const out = sqliteQuery(dbPath, `SELECT value FROM settings WHERE key = 'storagePath';`).trim()
  if (out) return out
  return path.join(os.homedir(), 'Documents', 'MeetingIntelligence')
}

function getMeeting(dbPath, id) {
  const out = sqliteQuery(
    dbPath,
    `SELECT id, title, date, status, COALESCE(transcript_path, ''), COALESCE(duration_seconds, '')
       FROM meetings WHERE id = '${sqlEscape(id)}';`
  ).trim()
  if (!out) return null
  const cols = out.split('\t')
  return {
    id: cols[0],
    title: cols[1],
    date: cols[2],
    status: cols[3],
    transcript_path: cols[4] || null,
    duration_seconds: cols[5] ? Number(cols[5]) : null
  }
}

function sanitizeForFilename(title) {
  let safe = title.replace(/[\/\\:*?"<>|]/g, '-')
  safe = safe.replace(/[-\s]+/g, ' ').trim()
  if (safe.length > 60) safe = safe.substring(0, 60).trim()
  return safe
}

function formatDate(iso) {
  const d = new Date(iso)
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

function main() {
  const args = parseArgs(process.argv)

  if (!args.meeting || !args.input) {
    printUsage()
    process.exit(2)
  }

  if (!fs.existsSync(args.input)) {
    console.error(`Input file not found: ${args.input}`)
    process.exit(1)
  }

  const dbPath = args.db || defaultDbPath()
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`)
    process.exit(1)
  }

  // Confirm sqlite3 CLI is available.
  const probe = spawnSync('sqlite3', ['-version'], { encoding: 'utf-8' })
  if (probe.status !== 0) {
    console.error('The `sqlite3` CLI is required but not found on PATH.')
    process.exit(1)
  }

  const meeting = getMeeting(dbPath, args.meeting)
  if (!meeting) {
    console.error(`Meeting not found: ${args.meeting}`)
    process.exit(1)
  }

  console.log('[recover] Meeting:')
  console.log(`  id:           ${meeting.id}`)
  console.log(`  title:        ${meeting.title}`)
  console.log(`  date:         ${meeting.date}`)
  console.log(`  status:       ${meeting.status}`)
  console.log(`  transcript:   ${meeting.transcript_path || '(none)'}`)
  console.log(`  duration:     ${meeting.duration_seconds ?? '(unset)'}`)

  if (meeting.transcript_path) {
    console.error(
      `\nMeeting already has a transcript_path (${meeting.transcript_path}). ` +
        'Refusing to overwrite. Delete that file and clear transcript_path first if you really want to replace it.'
    )
    process.exit(1)
  }

  const storage = resolveStoragePath(dbPath, args.storage)
  const transcriptsDir = path.join(storage, 'transcripts')
  if (!fs.existsSync(transcriptsDir)) {
    console.error(`Transcripts directory does not exist: ${transcriptsDir}`)
    process.exit(1)
  }

  const shortId = meeting.id.split('-')[0]
  const safeTitle = sanitizeForFilename(meeting.title || 'Meeting')
  const dateStr = formatDate(meeting.date)
  const filename = `Recovered - ${safeTitle} - ${dateStr} (${shortId}).md`
  const fullPath = path.join(transcriptsDir, filename)

  if (fs.existsSync(fullPath)) {
    console.error(`\nA file already exists at ${fullPath}. Aborting to avoid overwrite.`)
    process.exit(1)
  }

  const content = fs.readFileSync(args.input, 'utf-8')
  const duration =
    typeof args.duration === 'number' && !Number.isNaN(args.duration) ? args.duration : null

  console.log('\n[recover] Plan:')
  console.log(`  write file:   ${fullPath}`)
  console.log(`  bytes:        ${Buffer.byteLength(content, 'utf-8')}`)
  console.log(`  set status:   transcribed`)
  console.log(`  set transcript_path: ${filename}`)
  if (duration !== null) console.log(`  set duration_seconds: ${duration}`)

  if (args.dryRun) {
    console.log('\n[recover] --dry-run: no changes written.')
    process.exit(0)
  }

  // Write the file first; if the DB update fails we want the file present for
  // a manual retry rather than a half-applied state with no file.
  fs.writeFileSync(fullPath, content, 'utf-8')
  console.log(`\n[recover] Wrote transcript: ${fullPath}`)

  const setParts = [
    `transcript_path = '${sqlEscape(filename)}'`,
    `status = 'transcribed'`,
    `updated_at = datetime('now')`
  ]
  if (duration !== null) setParts.push(`duration_seconds = ${duration}`)
  const sql = `UPDATE meetings SET ${setParts.join(', ')} WHERE id = '${sqlEscape(args.meeting)}';`
  sqliteRun(dbPath, sql)
  console.log('[recover] DB updated.')

  console.log(
    '\n[recover] Done. Quit and restart Cyggie so the main process clears its in-memory ' +
      'currentMeetingId, then click into the meeting — the transcript should appear.'
  )
}

main()
