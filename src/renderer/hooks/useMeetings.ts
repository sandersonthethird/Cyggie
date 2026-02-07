import { useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { Meeting, MeetingListFilter } from '../../shared/types/meeting'

export function useMeetings() {
  const meetings = useAppStore((s) => s.meetings)
  const setMeetings = useAppStore((s) => s.setMeetings)

  const fetchMeetings = useCallback(
    async (filter?: MeetingListFilter) => {
      const result = await window.api.invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, filter)
      setMeetings(result)
    },
    [setMeetings]
  )

  const deleteMeeting = useCallback(
    async (id: string) => {
      await window.api.invoke(IPC_CHANNELS.MEETING_DELETE, id)
      await fetchMeetings()
    },
    [fetchMeetings]
  )

  useEffect(() => {
    fetchMeetings()
  }, [fetchMeetings])

  return { meetings, fetchMeetings, deleteMeeting }
}
