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

  setMeetings: (meetings: Meeting[]) => void
  selectMeeting: (id: string | null) => void
  setCalendarEvents: (events: CalendarEvent[]) => void
  setCalendarConnected: (connected: boolean) => void
  dismissEvent: (eventId: string) => void
  setSearchQuery: (query: string) => void
  setSearchFilter: (filter: SearchFilter | null) => void
  setSearchResults: (results: SearchResult[]) => void
  setIsSearching: (searching: boolean) => void
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
  setIsSearching: (searching) => set({ isSearching: searching })
}))
