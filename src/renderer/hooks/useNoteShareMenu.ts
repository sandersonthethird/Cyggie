import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { WebShareResponse } from '../../shared/types/web-share'
import { api } from '../api'

export function useNoteShareMenu(noteId: string | null, contentDraft: string) {
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const shareMenuRef = useRef<HTMLDivElement>(null)

  const canShare = !!contentDraft.trim()

  // Close share menu on click outside
  useEffect(() => {
    if (!shareMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (shareMenuRef.current && !shareMenuRef.current.contains(e.target as Node)) {
        setShareMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [shareMenuOpen])

  const handleCopyText = useCallback(() => {
    setShareMenuOpen(false)
    navigator.clipboard.writeText(contentDraft).catch(() => {
      alert('Failed to copy text to clipboard.')
    })
  }, [contentDraft])

  const handleWebShare = useCallback(async () => {
    if (!noteId) return
    setShareMenuOpen(false)
    try {
      const result = await api.invoke<WebShareResponse>(IPC_CHANNELS.WEB_SHARE_CREATE_NOTE, noteId)
      if (result.success && result.url) {
        await navigator.clipboard.writeText(result.url)
        alert('Share link copied to clipboard!')
      } else {
        alert(result.message ?? 'Failed to create share link.')
      }
    } catch {
      alert('Failed to create share link.')
    }
  }, [noteId])

  return {
    shareMenuOpen,
    setShareMenuOpen,
    shareMenuRef,
    canShare,
    handleCopyText,
    handleWebShare,
  }
}
