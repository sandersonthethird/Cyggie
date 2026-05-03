/**
 * Read/write the persisted "AI Chats sidebar expanded" preference.
 * Falls back to in-memory (returns the default) when localStorage is
 * unavailable or quota-exceeded — never throws.
 */

const KEY = 'cyggie:sidebar:aiChatsExpanded'

export function readAIChatsExpanded(defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* fall through to default */
  }
  return defaultValue
}

export function writeAIChatsExpanded(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    /* in-memory fallback */
  }
}
