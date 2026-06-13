/**
 * Unit test for the one-time, race-proof pull-watermark reset
 * (src/main/services/sync-repull-once.service.ts).
 *
 * Verifies it resets this device's pull watermark to 0 exactly once (so the
 * next pull re-applies meetings/contacts that could only apply after migration
 * 123 added their columns), sets the local done-flag, and is a strict no-op on
 * subsequent launches or when the device id / sync_state row isn't provisioned.
 *
 * Unlike PR 2b's reheal, this is SYNCHRONOUS and does NOT trigger a pull — the
 * pull service's own start() does the first pull right after this returns.
 *
 * In-memory better-sqlite3 with just the tables the service touches: settings
 * (local-only flag + syncDeviceId) and sync_state (the watermark).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { resetPullWatermarkForRepullOnce } from '../main/services/sync-repull-once.service'

function freshDb(opts: { deviceId?: string; watermark?: string } = {}): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0', last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  if (opts.deviceId) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('syncDeviceId', ?)").run(opts.deviceId)
    db.prepare('INSERT INTO sync_state (device_id, user_id, last_pulled_lamport) VALUES (?, ?, ?)').run(
      opts.deviceId,
      'user-1',
      opts.watermark ?? '500',
    )
  }
  return db
}

const watermark = (db: Database.Database, deviceId: string) =>
  (db.prepare('SELECT last_pulled_lamport AS v FROM sync_state WHERE device_id = ?').get(deviceId) as
    | { v: string }
    | undefined)?.v
const doneFlag = (db: Database.Database) =>
  (db.prepare("SELECT value FROM settings WHERE key = 'meetingRepullV2Done'").get() as
    | { value: string }
    | undefined)?.value

describe('resetPullWatermarkForRepullOnce', () => {
  it('resets the watermark to 0 and sets the done-flag (once)', () => {
    const db = freshDb({ deviceId: 'dev-1', watermark: '999' })
    const res = resetPullWatermarkForRepullOnce(db)
    expect(res.reset).toBe(true)
    expect(watermark(db, 'dev-1')).toBe('0')
    expect(doneFlag(db)).toBe('1')
  })

  it('is a no-op on the second run (done-flag set) — never resets twice', () => {
    const db = freshDb({ deviceId: 'dev-1', watermark: '999' })
    resetPullWatermarkForRepullOnce(db)
    // Simulate the watermark having advanced again after the heal.
    db.prepare("UPDATE sync_state SET last_pulled_lamport = '1200' WHERE device_id = 'dev-1'").run()
    const res = resetPullWatermarkForRepullOnce(db)
    expect(res.reset).toBe(false)
    expect(watermark(db, 'dev-1')).toBe('1200') // untouched
  })

  it('no-ops without setting the flag when the device id is not provisioned (retries later)', () => {
    const db = freshDb() // no syncDeviceId, no sync_state row
    const res = resetPullWatermarkForRepullOnce(db)
    expect(res.reset).toBe(false)
    expect(doneFlag(db)).toBeUndefined()
  })

  it('is re-armed vs PR 2b: a set divergedMeetingRehealV1Done does NOT suppress it', () => {
    const db = freshDb({ deviceId: 'dev-1', watermark: '999' })
    db.prepare("INSERT INTO settings (key, value) VALUES ('divergedMeetingRehealV1Done', '1')").run()
    const res = resetPullWatermarkForRepullOnce(db)
    expect(res.reset).toBe(true)
    expect(watermark(db, 'dev-1')).toBe('0')
  })
})
