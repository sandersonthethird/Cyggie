import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { searchMeetings, advancedSearch, getAllSpeakers, getSuggestions, getCategorizedSuggestions } from '../database/repositories/search.repo'
import type { AdvancedSearchParams } from '../../shared/types/meeting'

export function registerSearchHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SEARCH_QUERY, (_event, query: string, limit?: number) => {
    if (!query.trim()) return []
    return searchMeetings(query, limit)
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_ADVANCED, (_event, params: AdvancedSearchParams) => {
    return advancedSearch(params)
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_ALL_SPEAKERS, () => {
    return getAllSpeakers()
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SUGGEST, (_event, prefix: string) => {
    if (!prefix || prefix.trim().length < 2) return []
    return getSuggestions(prefix.trim())
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_CATEGORIZED, (_event, prefix: string) => {
    if (!prefix || prefix.trim().length < 2) return { people: [], companies: [], meetings: [] }
    return getCategorizedSuggestions(prefix.trim())
  })
}
