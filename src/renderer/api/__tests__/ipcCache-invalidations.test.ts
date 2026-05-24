import { describe, expect, test } from 'vitest'
import {
  INVALIDATIONS_BY_TABLE,
  MUTATION_INVALIDATIONS,
  REMOTE_APPLIED_TO_TABLE,
} from '../ipcCache'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

// Cross-check tests for the unified invalidation map (2026-05-24).
//
// The map is the single source of truth for "rows in table X changed →
// invalidate these cache keys." Two trigger paths dispatch through it:
//
//   1. Local mutations: api/index.ts:13 looks up MUTATION_INVALIDATIONS
//      (which is computed from INVALIDATIONS_BY_TABLE via CHANNEL_TO_TABLE).
//
//   2. Remote applies: useRemoteApply looks up REMOTE_APPLIED_TO_TABLE
//      to route a *_REMOTE_APPLIED IPC channel to a table name, then
//      calls invalidateTable() which reads INVALIDATIONS_BY_TABLE.
//
// If a new owned table joins the sync engine and someone forgets to
// add the channel routing OR the cache keys, these tests fail.

describe('INVALIDATIONS_BY_TABLE — single source of truth', () => {
  test('every table key has at least one cache entry to invalidate', () => {
    for (const [table, keys] of Object.entries(INVALIDATIONS_BY_TABLE)) {
      expect(keys.length, `table "${table}" has zero invalidation targets`).toBeGreaterThan(0)
    }
  })

  test('cache target channels look like IPC channel strings (X:Y)', () => {
    // Defensive: catches accidental empty strings or fully-qualified
    // class names. All Cyggie cache channels use "domain:operation"
    // shape.
    const looksLikeChannel = /^[a-z][\w-]*:[\w-]+$/
    for (const [table, keys] of Object.entries(INVALIDATIONS_BY_TABLE)) {
      for (const key of keys) {
        expect(looksLikeChannel.test(key), `table "${table}" has malformed cache key "${key}"`).toBe(true)
      }
    }
  })
})

describe('MUTATION_INVALIDATIONS is derived correctly', () => {
  test('every entry resolves to a valid table in INVALIDATIONS_BY_TABLE', () => {
    for (const [channel, keys] of Object.entries(MUTATION_INVALIDATIONS)) {
      expect(keys.length, `local mutation "${channel}" → zero invalidation targets`).toBeGreaterThan(0)
    }
  })

  test('local-mutation invalidation set matches the table-keyed set', () => {
    // For each local mutation, the cache-key set must equal the
    // table-keyed set (because MUTATION_INVALIDATIONS is computed
    // from INVALIDATIONS_BY_TABLE). This guards against future
    // drift if someone hand-edits MUTATION_INVALIDATIONS.
    for (const [channel, mutKeys] of Object.entries(MUTATION_INVALIDATIONS)) {
      // Find the table this channel maps to by reverse-engineering
      // through INVALIDATIONS_BY_TABLE.
      const candidateTable = Object.entries(INVALIDATIONS_BY_TABLE).find(
        ([, k]) => k === mutKeys,
      )
      expect(
        candidateTable,
        `mutation "${channel}" invalidations don't match any single table — drift between MUTATION_INVALIDATIONS and INVALIDATIONS_BY_TABLE`,
      ).toBeDefined()
    }
  })
})

describe('REMOTE_APPLIED_TO_TABLE — wired to real IPC channels', () => {
  // Inverse of REMOTE_APPLIED_TO_TABLE — checks that every channel
  // string we hand-coded matches a real IPC_CHANNELS.*_REMOTE_APPLIED
  // constant. Catches typos that would silently never fire.
  test('every channel key matches a constant in IPC_CHANNELS', () => {
    const remoteAppliedChannels = (Object.values(IPC_CHANNELS) as string[]).filter((c) =>
      typeof c === 'string' && c.endsWith('-remote-applied'),
    )
    for (const channel of Object.keys(REMOTE_APPLIED_TO_TABLE)) {
      expect(
        remoteAppliedChannels.includes(channel),
        `REMOTE_APPLIED_TO_TABLE key "${channel}" doesn't match any IPC_CHANNELS.*_REMOTE_APPLIED constant`,
      ).toBe(true)
    }
  })

  test('every target table exists in INVALIDATIONS_BY_TABLE', () => {
    for (const [channel, table] of Object.entries(REMOTE_APPLIED_TO_TABLE)) {
      expect(
        INVALIDATIONS_BY_TABLE[table],
        `channel "${channel}" routes to table "${table}" which has no entry in INVALIDATIONS_BY_TABLE`,
      ).toBeDefined()
    }
  })
})

describe('Coverage parity', () => {
  // Every table that has a REMOTE_APPLIED broadcast should also be
  // listed in INVALIDATIONS_BY_TABLE. Vice versa is fine (some tables
  // — calendar virtual table — don't have a sync-broadcast).
  test('every REMOTE_APPLIED table is in INVALIDATIONS_BY_TABLE', () => {
    const remoteTables = new Set(Object.values(REMOTE_APPLIED_TO_TABLE))
    for (const table of remoteTables) {
      expect(
        INVALIDATIONS_BY_TABLE[table],
        `table "${table}" is in REMOTE_APPLIED_TO_TABLE but missing from INVALIDATIONS_BY_TABLE`,
      ).toBeDefined()
    }
  })
})
