// HTML5 input[type=email] reference regex — battle-tested, forgiving for
// international TLDs while rejecting obvious garbage like "bob@gmail".
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type EmailAction =
  | { type: 'add'; email: string }
  | { type: 'save'; oldEmail: string; newEmail: string }
  | { type: 'remove'; email: string }

export type EmailSavePlan =
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; actions: EmailAction[] }

// Pure planner for the two-email contact form. Validates both inputs and
// produces an ordered list of IPC actions for the caller to execute. Used by
// ContactPropertiesPanel.handleDone — no DOM, no IPC, no React deps so it can
// be unit-tested directly.
export function planEmailSaves(
  currentEmail1: string,
  currentEmail2: string,
  draftEmail1: string,
  draftEmail2: string,
): EmailSavePlan {
  const trimmed1 = draftEmail1.trim()
  const trimmed2 = draftEmail2.trim()

  if (trimmed1 && !EMAIL_RX.test(trimmed1)) {
    return { kind: 'invalid', message: 'Email 1 is not a valid email address' }
  }
  if (trimmed2 && !EMAIL_RX.test(trimmed2)) {
    return { kind: 'invalid', message: 'Email 2 is not a valid email address' }
  }
  if (trimmed2 && trimmed2.toLowerCase() === trimmed1.toLowerCase()) {
    return { kind: 'invalid', message: 'Email 2 must differ from Email 1' }
  }

  const actions: EmailAction[] = []

  if (trimmed1 && trimmed1 !== currentEmail1) {
    actions.push(
      currentEmail1
        ? { type: 'save', oldEmail: currentEmail1, newEmail: trimmed1 }
        : { type: 'add', email: trimmed1 },
    )
  } else if (!trimmed1 && currentEmail1) {
    actions.push({ type: 'remove', email: currentEmail1 })
  }

  if (trimmed2 && trimmed2 !== currentEmail2) {
    actions.push(
      currentEmail2
        ? { type: 'save', oldEmail: currentEmail2, newEmail: trimmed2 }
        : { type: 'add', email: trimmed2 },
    )
  } else if (!trimmed2 && currentEmail2) {
    actions.push({ type: 'remove', email: currentEmail2 })
  }

  return { kind: 'ok', actions }
}
