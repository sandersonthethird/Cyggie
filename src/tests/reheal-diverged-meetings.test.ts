/**
 * Unit test for the one-time diverged-meeting re-heal
 * (src/main/services/reheal-diverged-meetings.service.ts).
 *
 * Verifies it resets this device's pull watermark exactly once (so a full
 * re-pull lets PR 2's reconcile heal pre-existing divergence), sets the local
 * done-flag, triggers a pull, and is a strict no-op on subsequent launches or
 * when prerequisites (device id / user) aren't available.
 *
 * In-memory better-sqlite3 with just the tables the service touches: settings
 * (local-only flag + syncDeviceId) and sync_state (the watermark).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database
const triggerSyncPull = vi.fn()

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))
vi.mock('../main/services/sync-bootstrap', () => ({
  triggerSyncPull: () => triggerSyncPull(),
}))

const { rehealDivergedMeetings } = await import('../main/services/reheal-diverged-meetings.service')

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
    db.prepare(
      'INSERT INTO sync_state (device_id, user_id, last_pulled_lamport) VALUES (?, ?, ?)',
    ).run(opts.deviceId, 'user-1', opts.watermark ?? '500')
  }
  return db
}

const watermark = (deviceId: string) =>
  (testDb.prepare('SELECT last_pulled_lamport AS v FROM sync_state WHERE device_id = ?').get(deviceId) as
    | { v: string }
    | undefined)?.v
const doneFlag = () =>
  (testDb.prepare("SELECT value FROM settings WHERE key = 'divergedMeetingRehealV1Done'").get() as
    | { value: string }
    | undefined)?.value

beforeEach(() => {
  triggerSyncPull.mockClear()
})

describe('rehealDivergedMeetings', () => {
  it('resets the watermark to 0, sets the done-flag, and triggers a pull (once)', () => {
    testDb = freshDb({ deviceId: 'dev-1', watermark: '999' })
    rehealDivergedMeetings('user-1')
    expect(watermark('dev-1')).toBe('0')
    expect(doneFlag()).toBe('1')
    expect(triggerSyncPull).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on the second run (done-flag set)', () => {
    testDb = freshDb({ deviceId: 'dev-1', watermark: '999' })
    rehealDivergedMeetings('user-1')
    triggerSyncPull.mockClear()
    // Simulate the watermark having advanced again after the heal.
    testDb.prepare("UPDATE sync_state SET last_pulled_lamport = '1200' WHERE device_id = 'dev-1'").run()
    rehealDivergedMeetings('user-1')
    expect(watermark('dev-1')).toBe('1200') // untouched
    expect(triggerSyncPull).not.toHaveBeenCalled()
  })

  it('no-ops without setting the flag when the device id is not provisioned (retries later)', () => {
    testDb = freshDb() // no syncDeviceId, no sync_state row
    rehealDivergedMeetings('user-1')
    expect(doneFlag()).toBeUndefined()
    expect(triggerSyncPull).not.toHaveBeenCalled()
  })

  it('no-ops when there is no signed-in user', () => {
    testDb = freshDb({ deviceId: 'dev-1' })
    rehealDivergedMeetings(null)
    expect(watermark('dev-1')).toBe('500') // untouched
    expect(doneFlag()).toBeUndefined()
    expect(triggerSyncPull).not.toHaveBeenCalled()
  })
})
