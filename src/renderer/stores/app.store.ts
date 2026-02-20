import { create } from 'zustand'
import type { Meeting, SearchResult } from '../../shared/types/meeting'
import type { CalendarEvent } from '../../shared/types/calendar'

export interface SearchFilter {
  type: 'person' | 'company'
  value: string
}

interface AppState {
  meetings: Meeting[]
  selectedMeetingId: string | null
  calendarEvents: CalendarEvent[]
  calendarConnected: boolean
  dismissedEventIds: Set<string>
  searchQuery: string
  searchFilter: SearchFilter | null
  searchResults: SearchResult[]
  isSearching: boolean
  searchDateFrom: string
  searchDateTo: string
  searchSpeakers: string[]
  allSpeakers: string[]
  showFilterPanel: boolean

  setMeetings: (meetings: Meeting[]) => void
  selectMeeting: (id: string | null) => void
  setCalendarEvents: (events: CalendarEvent[]) => void
  setCalendarConnected: (connected: boolean) => void
  dismissEvent: (eventId: string) => void
  setSearchQuery: (query: string) => void
  setSearchFilter: (filter: SearchFilter | null) => void
  setSearchResults: (results: SearchResult[]) => void
  setIsSearching: (searching: boolean) => void
  setSearchDateFrom: (dateFrom: string) => void
  setSearchDateTo: (dateTo: string) => void
  setSearchSpeakers: (speakers: string[]) => void
  setAllSpeakers: (speakers: string[]) => void
  setShowFilterPanel: (show: boolean) => void
  clearAdvancedFilters: () => void
  clearSearch: () => void
}

export const useAppStore = create<AppState>((set) => ({
  meetings: [],
  selectedMeetingId: null,
  calendarEvents: [],
  calendarConnected: false,
  dismissedEventIds: new Set(),
  searchQuery: '',
  searchFilter: null,
  searchResults: [],
  isSearching: false,
  searchDateFrom: '',
  searchDateTo: '',
  searchSpeakers: [],
  allSpeakers: [],
  showFilterPanel: false,

  setMeetings: (meetings) => set({ meetings }),
  selectMeeting: (id) => set({ selectedMeetingId: id }),
  setCalendarEvents: (events) => set({ calendarEvents: events }),
  setCalendarConnected: (connected) => set({ calendarConnected: connected }),
  dismissEvent: (eventId) =>
    set((state) => ({
      dismissedEventIds: new Set([...state.dismissedEventIds, eventId])
    })),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchFilter: (filter) => set({ searchFilter: filter }),
  setSearchResults: (results) => set({ searchResults: results }),
  setIsSearching: (searching) => set({ isSearching: searching }),
  setSearchDateFrom: (dateFrom) => set({ searchDateFrom: dateFrom }),
  setSearchDateTo: (dateTo) => set({ searchDateTo: dateTo }),
  setSearchSpeakers: (speakers) => set({ searchSpeakers: speakers }),
  setAllSpeakers: (speakers) => set({ allSpeakers: speakers }),
  setShowFilterPanel: (show) => set({ showFilterPanel: show }),
  clearAdvancedFilters: () => set({ searchDateFrom: '', searchDateTo: '', searchSpeakers: [] }),
  clearSearch: () =>
    set({
      searchQuery: '',
      searchFilter: null,
      searchResults: [],
      isSearching: false,
      searchDateFrom: '',
      searchDateTo: '',
      searchSpeakers: [],
      showFilterPanel: false
    })
}))

export const selectHasActiveFilters = (s: AppState): boolean =>
  s.searchDateFrom !== '' || s.searchDateTo !== '' || s.searchSpeakers.length > 0
