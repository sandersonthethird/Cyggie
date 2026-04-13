import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { WebShareResponse } from '../../shared/types/web-share'
import { api } from '../api'
import { useNotice } from '../components/common/NoticeModal'

export function useNoteShareMenu(noteId: string | null, contentDraft: string) {
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const shareMenuRef = useRef<HTMLDivElement>(null)
  const notice = useNotice()

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
      notice.show({ variant: 'error', title: 'Failed to copy text to clipboard' })
    })
  }, [contentDraft, notice])

  const handleWebShare = useCallback(async () => {
    if (!noteId) return
    setShareMenuOpen(false)
    try {
      const result = await api.invoke<WebShareResponse>(IPC_CHANNELS.WEB_SHARE_CREATE_NOTE, noteId)
      if (result.success && result.url) {
        await navigator.clipboard.writeText(result.url)
        notice.show({ variant: 'success', title: 'Share link copied to clipboard', url: result.url })
      } else {
        notice.show({ variant: 'error', title: 'Failed to create share link', message: result.message })
      }
    } catch {
      notice.show({ variant: 'error', title: 'Failed to create share link' })
    }
  }, [noteId, notice])

  return {
    shareMenuOpen,
    setShareMenuOpen,
    shareMenuRef,
    canShare,
    handleCopyText,
    handleWebShare,
  }
}
