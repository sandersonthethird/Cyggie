/**
 * Translate raw IPC/Anthropic error strings into user-facing messages.
 *
 *   raw stringified error  →  parseChatError  →  inline error message
 *
 * Recognized cases:
 *   - low credit balance       (Anthropic billing)
 *   - missing API key          (settings not configured)
 *   - 401 / invalid API key    (key rejected by Anthropic)
 *   - generic                  (fallback message)
 */
export function parseChatError(errStr: string): string {
  // Try to extract Anthropic API error message from the JSON blob
  try {
    const jsonMatch = errStr.match(/\{.*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const msg: string | undefined = parsed?.error?.message
      if (msg) {
        if (msg.toLowerCase().includes('credit balance')) {
          return 'Your Anthropic API credit balance is too low. Please add credits at console.anthropic.com → Billing.'
        }
        return msg
      }
    }
  } catch {
    // fall through to raw string handling
  }
  if (errStr.toLowerCase().includes('credit balance')) {
    return 'Your Anthropic API credit balance is too low. Please add credits at console.anthropic.com → Billing.'
  }
  if (errStr.includes('API key not configured')) {
    return 'Claude API key is not configured. Go to Settings to add it.'
  }
  if (errStr.includes('401') || errStr.toLowerCase().includes('invalid api key') || errStr.toLowerCase().includes('authentication')) {
    return 'Invalid API key. Please check your Claude API key in Settings.'
  }
  return 'Something went wrong. Please try again.'
}

/** Distinguish abort-induced errors from real failures. */
export function isAbortError(errStr: string): boolean {
  return errStr.includes('abort') || errStr.includes('Abort')
}
