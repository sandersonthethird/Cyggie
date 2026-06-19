// COL_MAP integrity (eng-review 3A) for the field-LWW apply maps.
//
// The dynamic field-LWW UPSERT (upsertFieldLwwRow) writes a winning column via
// `${snake} = @${camel}`, looking the camel up in the map. A wrong/duplicate
// entry means a column silently never syncs (no error, just lost data). These
// checks catch the realistic authoring errors without depending on a DB fixture:
//   1. no duplicate snake keys (a later dupe shadows an earlier one),
//   2. no duplicate camel values (two snakes binding the same @param),
//   3. each camel is the exact camelCase of its snake — catches a mistyped
//      mapping (the #51 class: a lossy/typo'd snake↔camel pair).
//
// (Full "every table column is mapped" coverage is exercised by the apply
// behavior tests + the upsert INSERT column list; buildTestDbFull's meetings
// schema is a known-incomplete oracle, so it's deliberately not used here.)

import { describe, expect, it } from 'vitest'
import { CONTACT_COL_MAP, MEETING_COL_MAP } from '@main/services/sync-remote-apply'

function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

describe('field-LWW COL_MAP integrity', () => {
  for (const { table, map } of [
    { table: 'contacts', map: CONTACT_COL_MAP },
    { table: 'meetings', map: MEETING_COL_MAP },
  ]) {
    const snakes = map.map(([s]) => s)
    const camels = map.map(([, c]) => c)

    it(`${table}: no duplicate snake columns`, () => {
      expect(new Set(snakes).size).toBe(snakes.length)
    })

    it(`${table}: no duplicate camel bind keys`, () => {
      expect(new Set(camels).size).toBe(camels.length)
    })

    it(`${table}: every camel is the exact camelCase of its snake`, () => {
      const mismatches = map
        .filter(([snake, camel]) => snakeToCamel(snake) !== camel)
        .map(([snake, camel]) => `${snake} → ${camel} (expected ${snakeToCamel(snake)})`)
      expect(mismatches).toEqual([])
    })
  }
})
