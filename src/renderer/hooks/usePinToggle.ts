import { useState } from 'react'
import { api } from '../api'

// Sort invariant mirrors DB: is_pinned DESC, updated_at DESC
export function sortByPin<T extends { isPinned: boolean; updatedAt: string }>(notes: T[]): T[] {
  return [...notes].sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

export function usePinToggle<T extends { id: string; isPinned: boolean; updatedAt: string }>(
  ipcChannel: string,
  setNotes: React.Dispatch<React.SetStateAction<T[]>>
) {
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())

  const togglePin = async (note: T) => {
    setTogglingIds((prev) => new Set([...prev, note.id]))
    try {
      await api.invoke(ipcChannel, note.id, { isPinned: !note.isPinned })
      setNotes((prev) =>
        sortByPin(prev.map((n) => (n.id === note.id ? { ...n, isPinned: !n.isPinned } : n)))
      )
    } catch (e) {
      console.error(`[usePinToggle] toggle failed for ${note.id}:`, e)
    } finally {
      setTogglingIds((prev) => {
        const s = new Set(prev)
        s.delete(note.id)
        return s
      })
    }
  }

  return { togglePin, togglingIds }
}
