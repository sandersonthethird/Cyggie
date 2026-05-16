/**
 * TODO: Phase 5 audit deferred — this file references
 * `../main/database/repositories/company-notes.repo` which doesn't exist in
 * the codebase (never has, per git log). The dedup guard logic the tests
 * describe likely lives in another module now (search for createCompanyNote
 * usages in services/partner-meeting-reconcile.service.ts). Re-create these
 * tests against the actual implementation when revisiting.
 */
import { describe, it } from 'vitest'

describe.skip('createCompanyNote dedup guard (deferred — repo module missing)', () => {
  it('placeholder', () => {})
})
