import { createContext, useContext, useMemo, useState, type ReactNode, type RefCallback } from 'react'

/**
 * Ownership boundary for the chat-panel portal targets.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ PanelOutletProvider (wraps Layout.body)                  │
 *   │                                                          │
 *   │   useState: threadEl, composerEl                         │
 *   │   Exposes via Context:                                   │
 *   │     setThreadEl, setComposerEl  (stable useState setters)│
 *   │     threadEl, composerEl                                 │
 *   └────────┬────────────────┬───────────────────┬────────────┘
 *            │ writes         │ writes            │ reads
 *   ┌────────▼───────┐ ┌──────▼────────┐ ┌────────▼─────────┐
 *   │ AIChatPanel    │ │AIChatFullscreen│ │ ChatPanelRoot    │
 *   │ <div ref=set>  │ │ <div ref=set>  │ │ createPortal(el) │
 *   └────────────────┘ └────────────────┘ └──────────────────┘
 *
 * Replaces the prior approach of storing the mount-point DOM nodes in
 * the Zustand panel store. React Context is the right tool here: the
 * lifetimes are tied to the React tree, the setters are guaranteed-stable
 * useState identities, and Zustand stays focused on app state.
 */

interface PanelOutletValue {
  threadEl: HTMLDivElement | null
  composerEl: HTMLDivElement | null
  setThreadEl: RefCallback<HTMLDivElement>
  setComposerEl: RefCallback<HTMLDivElement>
}

const PanelOutletContext = createContext<PanelOutletValue | null>(null)

export function PanelOutletProvider({ children }: { children: ReactNode }) {
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null)
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null)
  // useState setters keep stable identity across renders; useMemo ties
  // the context value to el changes only so consumers don't re-render
  // on every parent render.
  const value = useMemo<PanelOutletValue>(
    () => ({ threadEl, composerEl, setThreadEl, setComposerEl }),
    [threadEl, composerEl],
  )
  return <PanelOutletContext.Provider value={value}>{children}</PanelOutletContext.Provider>
}

export function usePanelOutlet(): PanelOutletValue {
  const ctx = useContext(PanelOutletContext)
  if (!ctx) throw new Error('usePanelOutlet must be used inside <PanelOutletProvider>')
  return ctx
}
