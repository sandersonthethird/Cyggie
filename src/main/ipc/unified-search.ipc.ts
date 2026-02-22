import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { searchUnified } from '../database/repositories/search.repo'
import type {
  UnifiedSearchAnswerResponse,
  UnifiedSearchResponse
} from '../../shared/types/unified-search'
import { getCurrentUserId } from '../security/current-user'
import { logAppEvent } from '../database/repositories/audit.repo'
import { getSetting } from '../database/repositories/settings.repo'
import { getCredential } from '../security/credentials'
import type { LLMProvider } from '../llm/provider'
import { ClaudeProvider } from '../llm/claude-provider'
import { OllamaProvider } from '../llm/ollama-provider'
import type { LlmProvider } from '../../shared/types/settings'

let unifiedSearchAbortController: AbortController | null = null

function sendProgress(text: string): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, text)
    }
  }
}

function sendClear(): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, null)
    }
  }
}

function getProvider(): LLMProvider {
  const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider
  if (providerType === 'ollama') {
    const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
    const model = getSetting('ollamaModel') || 'llama3.1'
    return new OllamaProvider(model, host)
  }

  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) {
    throw new Error('Claude API key not configured. Go to Settings to add it.')
  }
  return new ClaudeProvider(apiKey)
}

function buildAnswerPrompt(query: string, search: UnifiedSearchResponse): string {
  const top = search.flat.slice(0, 8)
  const context = top
    .map((result, index) => {
      return [
        `[${index + 1}] ${result.citationLabel}`,
        `Type: ${result.entityType}`,
        result.companyName ? `Company: ${result.companyName}` : null,
        `Snippet: ${result.snippet || '(no snippet)'}`,
        ''
      ].filter(Boolean).join('\n')
    })
    .join('\n')

  return [
    'Use only the sourced excerpts below.',
    'When making a claim, cite one or more source numbers like [1] or [2][4].',
    'If evidence is insufficient, say that explicitly.',
    '',
    'Sources:',
    context,
    '---',
    `Question: ${query}`
  ].join('\n')
}

function ensureCitationSection(answer: string, search: UnifiedSearchResponse): string {
  const citations = search.flat.slice(0, 5)
  const hasInlineCitation = /\[\d+\]/.test(answer)
  const sourceLines = citations.map((citation, index) => `- [${index + 1}] ${citation.citationLabel}`)
  const sourcesBlock = ['Sources', ...sourceLines].join('\n')
  if (hasInlineCitation) {
    return `${answer.trim()}\n\n${sourcesBlock}`
  }
  return `${answer.trim()}\n\n(Added citations)\n${sourcesBlock}`
}

export function registerUnifiedSearchHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.UNIFIED_SEARCH_QUERY, (_event, query: string, limit?: number) => {
    const userId = getCurrentUserId()
    const started = Date.now()
    const results = searchUnified(query || '', limit ?? 40)
    logAppEvent(userId, 'search.query', {
      queryLength: (query || '').trim().length,
      resultCount: results.totalCount,
      latencyMs: Date.now() - started
    })
    return results
  })

  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_SEARCH_ANSWER,
    async (_event, query: string, limit?: number): Promise<UnifiedSearchAnswerResponse> => {
      const normalizedQuery = (query || '').trim()
      if (!normalizedQuery) {
        return {
          query: '',
          answer: 'Enter a question to get an answer with citations.',
          citations: []
        }
      }

      const userId = getCurrentUserId()
      const results = searchUnified(normalizedQuery, limit ?? 40)
      if (results.totalCount === 0) {
        return {
          query: normalizedQuery,
          answer: 'No matching sources were found, so I cannot provide a cited answer yet.',
          citations: []
        }
      }

      const provider = getProvider()
      const systemPrompt = [
        'You are a research assistant for CRM records.',
        'Answer only from provided sources and avoid speculation.',
        'Always cite sources using [n] markers.',
        'Keep answers concise and decision-oriented.'
      ].join(' ')
      const userPrompt = buildAnswerPrompt(normalizedQuery, results)

      unifiedSearchAbortController?.abort()
      unifiedSearchAbortController = new AbortController()
      const started = Date.now()
      const draft = await provider.generateSummary(
        systemPrompt,
        userPrompt,
        sendProgress,
        unifiedSearchAbortController.signal
      )
      sendClear()

      const answer = ensureCitationSection(draft, results)
      const citations = results.flat.slice(0, 5)
      logAppEvent(userId, 'search.answer_generated', {
        queryLength: normalizedQuery.length,
        citationCount: citations.length,
        latencyMs: Date.now() - started
      })

      return {
        query: normalizedQuery,
        answer,
        citations
      }
    }
  )
}
