import { useEffect, type RefObject } from 'react'

/**
 * Calls `onClickOutside` when a `mousedown` event lands outside the referenced element.
 *
 * Pass `enabled=false` (or skip the effect by not mounting the consumer) to skip
 * the listener; useful for menus/popovers gated on an `open` state.
 *
 *   const ref = useRef<HTMLDivElement>(null)
 *   useOutsideClick(ref, () => setOpen(false), open)
 */
export function useOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClickOutside: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClickOutside()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [ref, onClickOutside, enabled])
}
