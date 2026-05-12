import { createPortal } from 'react-dom'
import React, { useCallback, useRef, useState, type ReactNode } from 'react'
import styles from './Tooltip.module.css'

interface TooltipProps {
  /**
   * Text or rich content shown in the tooltip / popover. When ReactNode,
   * the wrapper applies a max-width so list-style layouts don't overflow.
   */
  content: string | ReactNode
  /** Which side of the trigger to show on (default: 'top') */
  side?: 'top' | 'right' | 'bottom'
  /** Hover delay in ms before showing (default: 400) */
  delay?: number
  children: ReactNode
}

const VIEWPORT_PAD = 8

export function Tooltip({ content, side = 'top', delay = 400, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const computePosition = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let top: number
    let left: number

    switch (side) {
      case 'right':
        top = rect.top + rect.height / 2
        left = rect.right + 6
        break
      case 'bottom':
        top = rect.bottom + 6
        left = rect.left + rect.width / 2
        break
      case 'top':
      default:
        top = rect.top - 6
        left = rect.left + rect.width / 2
        break
    }

    // Clamp to viewport to prevent clipping
    const vw = window.innerWidth
    const vh = window.innerHeight
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - VIEWPORT_PAD))
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - VIEWPORT_PAD))

    setPos({ top, left })
  }, [side])

  const handleEnter = useCallback(() => {
    timerRef.current = setTimeout(() => {
      computePosition()
      setVisible(true)
    }, delay)
  }, [delay, computePosition])

  const handleLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
  }, [])

  // Determine CSS transform based on side so the tooltip anchors correctly
  const transform = side === 'right'
    ? 'translateY(-50%)'
    : side === 'bottom'
      ? 'translateX(-50%)'
      : 'translate(-50%, -100%)'

  // Non-string content is a richer popover (lists, grouped sources, etc.).
  // Apply a max-width via inline style so layouts don't overflow on narrow
  // viewports. String content keeps the existing single-line behavior.
  const isRichContent = typeof content !== 'string'
  const tooltipStyle: React.CSSProperties = {
    top: pos.top,
    left: pos.left,
    transform,
    ...(isRichContent ? { maxWidth: 'min(360px, calc(100vw - 32px))' } : {}),
  }

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      // Mirror hover triggers on focus so keyboard navigation surfaces the
      // tooltip when the wrapped trigger receives focus. Tabbing into a
      // <button> child triggers onFocus on the wrapper via React's event
      // bubbling.
      onFocus={handleEnter}
      onBlur={handleLeave}
    >
      {children}
      {visible && createPortal(
        <div
          className={styles.tooltip}
          style={tooltipStyle}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  )
}
