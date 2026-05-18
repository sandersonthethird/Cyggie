import { getProvider } from './provider-factory'

const TITLE_SYSTEM_PROMPT = `You name AI chat transcripts. Reply with a 4–8 word title in title case.
No quotes, no trailing punctuation, no prefixes like "Title:" — just the title itself.`

const TITLE_GEN_TIMEOUT_MS = 10_000

function fallbackDateTitle(): string {
  return `AI Chat — ${new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chat-title timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export async function generateChatTitle(
  transcript: string,
  fallback: string = fallbackDateTitle()
): Promise<string> {
  if (!transcript || !transcript.trim()) return fallback
  try {
    const provider = getProvider('chat')
    const sample = transcript.slice(0, 2000)
    const raw = await withTimeout(
      provider.generateSummary(TITLE_SYSTEM_PROMPT, `Transcript:\n\n${sample}`),
      TITLE_GEN_TIMEOUT_MS
    )
    const cleaned = raw
      .trim()
      .split('\n')[0]
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^title:\s*/i, '')
      .trim()
    if (!cleaned) return fallback
    return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned
  } catch {
    return fallback
  }
}
