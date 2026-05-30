import { describe, expect, test } from 'vitest'
import { planEmailSaves } from '../contactEmails'

describe('planEmailSaves', () => {
  test('no change → empty action list', () => {
    const plan = planEmailSaves('a@x.com', 'b@x.com', 'a@x.com', 'b@x.com')
    expect(plan).toEqual({ kind: 'ok', actions: [] })
  })

  test('email2 added when none existed → add action', () => {
    const plan = planEmailSaves('a@x.com', '', 'a@x.com', 'b@x.com')
    expect(plan).toEqual({ kind: 'ok', actions: [{ type: 'add', email: 'b@x.com' }] })
  })

  test('email2 changed → save action with old + new', () => {
    const plan = planEmailSaves('a@x.com', 'b@x.com', 'a@x.com', 'c@x.com')
    expect(plan).toEqual({
      kind: 'ok',
      actions: [{ type: 'save', oldEmail: 'b@x.com', newEmail: 'c@x.com' }],
    })
  })

  test('email2 cleared → remove action', () => {
    const plan = planEmailSaves('a@x.com', 'b@x.com', 'a@x.com', '')
    expect(plan).toEqual({ kind: 'ok', actions: [{ type: 'remove', email: 'b@x.com' }] })
  })

  test('email1 added from empty → add action', () => {
    const plan = planEmailSaves('', '', 'a@x.com', '')
    expect(plan).toEqual({ kind: 'ok', actions: [{ type: 'add', email: 'a@x.com' }] })
  })

  test('email1 == email2 → invalid (must differ)', () => {
    const plan = planEmailSaves('', '', 'a@x.com', 'a@x.com')
    expect(plan).toEqual({ kind: 'invalid', message: 'Email 2 must differ from Email 1' })
  })

  test('email1 == email2 case-insensitive → invalid', () => {
    const plan = planEmailSaves('', '', 'Alice@x.com', 'alice@x.com')
    expect(plan).toEqual({ kind: 'invalid', message: 'Email 2 must differ from Email 1' })
  })

  test('invalid email1 format → invalid', () => {
    const plan = planEmailSaves('', '', 'bob@gmail', '')
    expect(plan).toEqual({ kind: 'invalid', message: 'Email 1 is not a valid email address' })
  })

  test('invalid email2 format → invalid', () => {
    const plan = planEmailSaves('a@x.com', '', 'a@x.com', 'bob@gmail')
    expect(plan).toEqual({ kind: 'invalid', message: 'Email 2 is not a valid email address' })
  })

  test('both fields changed at once → two actions in order (email1 then email2)', () => {
    const plan = planEmailSaves('a@x.com', 'b@x.com', 'a2@x.com', 'b2@x.com')
    expect(plan).toEqual({
      kind: 'ok',
      actions: [
        { type: 'save', oldEmail: 'a@x.com', newEmail: 'a2@x.com' },
        { type: 'save', oldEmail: 'b@x.com', newEmail: 'b2@x.com' },
      ],
    })
  })

  test('whitespace-only draft treated as empty', () => {
    const plan = planEmailSaves('a@x.com', 'b@x.com', 'a@x.com', '   ')
    expect(plan).toEqual({ kind: 'ok', actions: [{ type: 'remove', email: 'b@x.com' }] })
  })
})
