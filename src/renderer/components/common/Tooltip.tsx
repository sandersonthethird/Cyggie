import { createPortal } from 'react-dom'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import styles from './Tooltip.module.css'

interface TooltipProps {
  /** Text shown in the tooltip */
  content: string
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

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {children}
      {visible && createPortal(
        <div
          className={styles.tooltip}
          style={{ top: pos.top, left: pos.left, transform }}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  )
}
