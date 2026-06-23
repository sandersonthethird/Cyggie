import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../api/client'
import { createNote, type NoteDetail } from '../api/notes'
import { useAuthStore } from '../auth/store'

// Shared "compose a new note" flow, used by both the Notes list header and the
// note-detail compose button. Instant-create (desktop handleNewNote parity):
// POST an empty note, seed its detail cache so the editor opens with no spinner,
// invalidate the list, then push to the detail screen with ?new=1 so it
// auto-enters edit mode (and hard-deletes itself if abandoned empty).
//
//   tap compose ─▶ createNote('') ─▶ seed detail cache ─▶ push ?new=1 ─▶ editor
//
// `creating` guards re-entrancy and drives the button's disabled state.
export function useCreateNote(): {
  createNewNote: (opts?: { folderPath?: string | null }) => Promise<void>
  creating: boolean
} {
  const queryClient = useQueryClient()
  const signOut = useAuthStore((s) => s.signOut)
  const [creating, setCreating] = useState(false)

  const createNewNote = useCallback(
    async (opts?: { folderPath?: string | null }): Promise<void> => {
      if (creating) return
      setCreating(true)
      try {
        const note = await createNote(
          {
            content: '',
            title: null,
            folderPath: opts?.folderPath ?? undefined,
          },
          Date.now().toString(),
        )
        queryClient.setQueryData<NoteDetail>(['notes', 'detail', note.id], note)
        void queryClient.invalidateQueries({ queryKey: ['notes', 'list'] })
        router.push(`/notes/${note.id}?new=1`)
      } catch (err) {
        if (err instanceof ApiError && err.reauthRequired) {
          void signOut().then(() => router.replace('/(auth)/sign-in'))
          return
        }
        Alert.alert(
          'Could not create note',
          err instanceof Error ? err.message : 'Please try again',
        )
      } finally {
        setCreating(false)
      }
    },
    [creating, queryClient, signOut],
  )

  return { createNewNote, creating }
}
