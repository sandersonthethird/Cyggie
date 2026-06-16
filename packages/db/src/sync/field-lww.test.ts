import { describe, it, expect } from 'vitest'
import {
  mergeFieldLww,
  parseFieldLamports,
  type MergeFieldLwwInput,
} from './field-lww'

// Golden vectors for the field-level LWW decision. These same {existing,
// incoming, expected} shapes are the contract both the gateway (pg) and the
// desktop (sqlite) UPSERT builders must honor — see the call-site parity tests.

function merge(partial: Partial<MergeFieldLwwInput>): ReturnType<typeof mergeFieldLww> {
  return mergeFieldLww({
    existingFieldLamports: null,
    existingRowLamport: '0',
    incomingFieldLamports: null,
    incomingRowLamport: '0',
    incomingColumns: [],
    isInsert: false,
    ...partial,
  })
}

describe('mergeFieldLww — concurrent edits to different columns', () => {
  it('keeps both: incoming touches priority, existing keeps arr/stage', () => {
    const r = merge({
      existingFieldLamports: { arr: '5', priority: '5', stage: '7' },
      existingRowLamport: '7',
      incomingFieldLamports: { priority: '9' },
      incomingRowLamport: '9',
      incomingColumns: ['arr', 'priority'], // payload carries arr (unchanged value) + priority
    })
    // arr clock 5 == stored 5 → tie → existing keeps it (not a winner).
    // priority 9 > 5 → incoming wins.
    expect(r.winners).toEqual(['priority'])
    expect(r.mergedFieldLamports).toEqual({ arr: '5', priority: '9', stage: '7' })
    expect(r.newRowLamport).toBe('9') // max(7, 9)
  })
})

describe('mergeFieldLww — stale-view edit does not clobber (the core guarantee)', () => {
  it('B edits notes only; arr is in the whole-row payload but unchanged → A’s newer arr survives', () => {
    // B loaded the row when arr was stale, then edited only `notes`. B's
    // whole-row payload carries arr (stale value) but the map marks ONLY notes.
    const r = merge({
      // Stored map is DENSE (A's write densified it): arr bumped to 12, the
      // rest pinned at their 5 baseline — so notes' true baseline is 5, not 12.
      existingFieldLamports: { arr: '12', notes: '5', priority: '5' },
      existingRowLamport: '12',
      incomingFieldLamports: { notes: '9' }, // B's write changed only notes @9
      incomingRowLamport: '9',
      incomingColumns: ['arr', 'notes', 'priority'], // full payload B sent
    })
    expect(r.winners).toEqual(['notes']) // arr NOT eligible (not in map); notes 9 > 5
    expect(r.mergedFieldLamports).toEqual({ arr: '12', notes: '9', priority: '5' })
    expect(r.newRowLamport).toBe('12') // arr's newer clock preserved
  })
})

describe('mergeFieldLww — densify invariant across a migrated row', () => {
  it('A edits arr on a NULL-map row → map densifies, B’s later notes edit still wins', () => {
    // Step 1: migrated row (rowLamport 5, no map). A edits arr @12.
    const afterA = merge({
      existingFieldLamports: null,
      existingRowLamport: '5',
      incomingFieldLamports: { arr: '12' },
      incomingRowLamport: '12',
      incomingColumns: ['arr', 'notes', 'priority'],
    })
    // Densified: arr→12, the rest pinned to the 5 baseline.
    expect(afterA.mergedFieldLamports).toEqual({ arr: '12', notes: '5', priority: '5' })

    // Step 2: B (hadn't seen A) edits notes @9 against A's stored state.
    const afterB = merge({
      existingFieldLamports: afterA.mergedFieldLamports,
      existingRowLamport: afterA.newRowLamport, // 12
      incomingFieldLamports: { notes: '9' },
      incomingRowLamport: '9',
      incomingColumns: ['arr', 'notes', 'priority'],
    })
    expect(afterB.winners).toEqual(['notes']) // notes 9 > its true baseline 5
    expect(afterB.mergedFieldLamports).toEqual({ arr: '12', notes: '9', priority: '5' })
  })
})

describe('mergeFieldLww — same-column race', () => {
  it('later lamport wins', () => {
    const r = merge({
      existingFieldLamports: { arr: '5' },
      existingRowLamport: '5',
      incomingFieldLamports: { arr: '8' },
      incomingRowLamport: '8',
      incomingColumns: ['arr'],
    })
    expect(r.winners).toEqual(['arr'])
    expect(r.mergedFieldLamports.arr).toBe('8')
  })

  it('earlier lamport loses (no winner, existing retained)', () => {
    const r = merge({
      existingFieldLamports: { arr: '8' },
      existingRowLamport: '8',
      incomingFieldLamports: { arr: '5' },
      incomingRowLamport: '5',
      incomingColumns: ['arr'],
    })
    expect(r.winners).toEqual([])
    expect(r.mergedFieldLamports.arr).toBe('8')
    expect(r.newRowLamport).toBe('8') // max(8, 5)
  })

  it('tie → existing wins (matches gateway === tiebreak)', () => {
    const r = merge({
      existingFieldLamports: { arr: '5' },
      existingRowLamport: '5',
      incomingFieldLamports: { arr: '5' },
      incomingRowLamport: '5',
      incomingColumns: ['arr'],
    })
    expect(r.winners).toEqual([])
  })
})

describe('mergeFieldLww — BigInt comparison (not lexical)', () => {
  it('"10" beats "9" (string compare would be wrong)', () => {
    const r = merge({
      existingFieldLamports: { arr: '9' },
      existingRowLamport: '9',
      incomingFieldLamports: { arr: '10' },
      incomingRowLamport: '10',
      incomingColumns: ['arr'],
    })
    expect(r.winners).toEqual(['arr'])
    expect(r.mergedFieldLamports.arr).toBe('10')
    expect(r.newRowLamport).toBe('10')
  })

  it('handles large lamports beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '9007199254740993' // 2^53 + 1
    const bigger = '9007199254740994'
    const r = merge({
      existingFieldLamports: { arr: big },
      existingRowLamport: big,
      incomingFieldLamports: { arr: bigger },
      incomingRowLamport: bigger,
      incomingColumns: ['arr'],
    })
    expect(r.winners).toEqual(['arr'])
  })
})

describe('mergeFieldLww — fallback to row lamport for unmapped columns', () => {
  it('incoming column with no field clock uses incoming row lamport', () => {
    const r = merge({
      existingFieldLamports: {}, // no per-field clocks yet (pre-migration row)
      existingRowLamport: '3',
      incomingFieldLamports: null, // old client: whole-row write, no map
      incomingRowLamport: '5',
      incomingColumns: ['arr', 'priority'],
    })
    // Both fall back: incoming 5 > stored 3 → both win (whole-row LWW behavior).
    expect(r.winners.sort()).toEqual(['arr', 'priority'])
    expect(r.mergedFieldLamports).toEqual({ arr: '5', priority: '5' })
  })

  it('null incoming map with LOSING row lamport degrades to whole-row loss', () => {
    const r = merge({
      existingFieldLamports: { arr: '9' },
      existingRowLamport: '9',
      incomingFieldLamports: null,
      incomingRowLamport: '4',
      incomingColumns: ['arr', 'priority'],
    })
    // arr: 4 < 9 lose. priority: stored falls back to row 9, 4 < 9 lose.
    expect(r.winners).toEqual([])
  })
})

describe('mergeFieldLww — clean insert', () => {
  it('all incoming columns win, stamped at incoming clocks', () => {
    const r = merge({
      isInsert: true,
      incomingFieldLamports: { arr: '5' },
      incomingRowLamport: '5',
      incomingColumns: ['arr', 'priority'],
    })
    expect(r.winners.sort()).toEqual(['arr', 'priority'])
    expect(r.mergedFieldLamports).toEqual({ arr: '5', priority: '5' })
    expect(r.newRowLamport).toBe('5')
  })
})

describe('parseFieldLamports', () => {
  it('parses a JSON string map', () => {
    expect(parseFieldLamports('{"arr":"5"}')).toEqual({ arr: '5' })
  })
  it('passes through an object map', () => {
    expect(parseFieldLamports({ arr: '5' })).toEqual({ arr: '5' })
  })
  it('returns null for nullish', () => {
    expect(parseFieldLamports(null)).toBeNull()
    expect(parseFieldLamports(undefined)).toBeNull()
  })
  it('returns null for malformed JSON (2A degrade)', () => {
    expect(parseFieldLamports('{not json')).toBeNull()
  })
  it('returns null for non-object / array', () => {
    expect(parseFieldLamports('[1,2,3]')).toBeNull()
    expect(parseFieldLamports('"a string"')).toBeNull()
  })
  it('returns null if any value is not a string lamport', () => {
    expect(parseFieldLamports('{"arr":5}')).toBeNull()
  })
})
