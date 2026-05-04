import { create } from 'zustand'
import { getJSON, setJSON, removeKey } from '../lib/safe-storage'

/**
 * Persistent chat side-panel state.
 *
 *   PERSISTED (localStorage, debounced 200ms):
 *     cyggie:chat:open      → isOpen
 *     cyggie:chat:width     → width
 *     cyggie:chat:mode      → mode
 *     cyggie:chat:lastChatId → openSessionId
 *
 *   TRANSIENT (per-process):
 *     popped, returnTo, hasUnread, lastActionAt
 *     draftBySession, dismissedContextChips
 *     mountPointThread, mountPointComposer  ← portal targets, set by Rail/Fullscreen
 *
 * Why mountPoint* is state (not a ref): React.createPortal re-renders to a new
 * container only when the container value changes; refs don't trigger re-render
 * when reassigned. Storing the target as Zustand state means popping out (rail
 * unmounts → fullscreen mounts → setState fires) reliably swaps the portal.
 */

export type ChatPanelMode = 'thread' | 'switcher'

export const DEFAULT_PANEL_WIDTH = 400
export const MIN_PANEL_WIDTH = 320
export const MAX_PANEL_WIDTH = 600
export const MAX_DRAFT_KEYS = 50

const STORAGE_KEYS = {
  open: 'cyggie:chat:open',
  width: 'cyggie:chat:width',
  mode: 'cyggie:chat:mode',
  lastChatId: 'cyggie:chat:lastChatId',
} as const

interface ChatPanelState {
  // Persisted UI state
  isOpen: boolean
  mode: ChatPanelMode
  width: number
  /** The session currently displayed in the panel. Doubles as `lastChatId`
   *  for hydration on next launch. */
  openSessionId: string | null

  // Transient state
  popped: boolean
  returnTo: string | null
  hasUnread: boolean
  /** Bumped by every panel mutation (send / pin / rename / archive / delete /
   *  open new chat). Subscribed by AIChats list to refetch its row data. */
  lastActionAt: number

  /** Composer drafts keyed by sessionId. Sentinel '__draft__' for new-chat-
   *  not-yet-created. Capped at MAX_DRAFT_KEYS keys; oldest evicted on insert. */
  draftBySession: Record<string, string>

  /** Per-session in-memory dismissal of the context chip. Lifetime: process. */
  dismissedContextChips: Set<string>

  /** DOM nodes to portal PanelThread / PanelComposer into. Set via ref
   *  callbacks by AIChatPanel (rail) and AIChatFullscreen (route). */
  mountPointThread: HTMLDivElement | null
  mountPointComposer: HTMLDivElement | null

  // Actions
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setMode: (mode: ChatPanelMode) => void
  setWidth: (width: number) => void
  setOpenSessionId: (id: string | null) => void
  setPopped: (popped: boolean) => void
  setReturnTo: (path: string | null) => void
  setHasUnread: (b: boolean) => void
  bumpAction: () => void
  setDraft: (sessionId: string, text: string) => void
  clearDraft: (sessionId: string) => void
  dismissContextChip: (sessionId: string) => void
  setMountPointThread: (el: HTMLDivElement | null) => void
  setMountPointComposer: (el: HTMLDivElement | null) => void
}

// ── Initial state ────────────────────────────────────────────────────────
function loadPersistedState(): {
  isOpen: boolean
  mode: ChatPanelMode
  width: number
  openSessionId: string | null
} {
  const isOpen = getJSON<boolean>(STORAGE_KEYS.open, false)
  const rawMode = getJSON<string>(STORAGE_KEYS.mode, 'thread')
  const mode: ChatPanelMode = rawMode === 'switcher' ? 'switcher' : 'thread'
  const rawWidth = getJSON<number>(STORAGE_KEYS.width, DEFAULT_PANEL_WIDTH)
  const width = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, rawWidth || DEFAULT_PANEL_WIDTH))
  const openSessionId = getJSON<string | null>(STORAGE_KEYS.lastChatId, null)
  return { isOpen, mode, width, openSessionId }
}

// ── Persistence (debounced 200 ms) ───────────────────────────────────────
let persistTimer: number | null = null
function schedulePersist(state: ChatPanelState) {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    setJSON(STORAGE_KEYS.open, state.isOpen)
    setJSON(STORAGE_KEYS.mode, state.mode)
    setJSON(STORAGE_KEYS.width, state.width)
    if (state.openSessionId) setJSON(STORAGE_KEYS.lastChatId, state.openSessionId)
    else removeKey(STORAGE_KEYS.lastChatId)
  }, 200)
}

// ── Draft eviction ───────────────────────────────────────────────────────
function evictOldestDraftKey(drafts: Record<string, string>): Record<string, string> {
  const keys = Object.keys(drafts)
  if (keys.length <= MAX_DRAFT_KEYS) return drafts
  // Lexicographic sort approximates insert order for v4 UUIDs; the goal is
  // bounded growth, not strict LRU correctness.
  keys.sort()
  const next = { ...drafts }
  for (let i = 0; i < keys.length - MAX_DRAFT_KEYS; i++) delete next[keys[i]]
  return next
}

// ── Store ────────────────────────────────────────────────────────────────
const persisted = loadPersistedState()

export const useChatPanelStore = create<ChatPanelState>((set, get) => ({
  // Persisted slice (loaded from localStorage)
  isOpen: persisted.isOpen,
  mode: persisted.mode,
  width: persisted.width,
  openSessionId: persisted.openSessionId,

  // Transient
  popped: false,
  returnTo: null,
  hasUnread: false,
  lastActionAt: 0,
  draftBySession: {},
  dismissedContextChips: new Set<string>(),
  mountPointThread: null,
  mountPointComposer: null,

  setOpen: (isOpen) => {
    set({ isOpen, hasUnread: isOpen ? false : get().hasUnread })
    schedulePersist(get())
  },

  toggleOpen: () => {
    const next = !get().isOpen
    set({ isOpen: next, hasUnread: next ? false : get().hasUnread })
    schedulePersist(get())
  },

  setMode: (mode) => {
    set({ mode })
    schedulePersist(get())
  },

  setWidth: (width) => {
    const clamped = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width))
    set({ width: clamped })
    schedulePersist(get())
  },

  setOpenSessionId: (openSessionId) => {
    set({ openSessionId })
    schedulePersist(get())
  },

  setPopped: (popped) => set({ popped }),
  setReturnTo: (returnTo) => set({ returnTo }),
  setHasUnread: (hasUnread) => set({ hasUnread }),
  bumpAction: () => set({ lastActionAt: Date.now() }),

  setDraft: (sessionId, text) => {
    const next = evictOldestDraftKey({ ...get().draftBySession, [sessionId]: text })
    set({ draftBySession: next })
  },

  clearDraft: (sessionId) => {
    const { [sessionId]: _, ...rest } = get().draftBySession
    set({ draftBySession: rest })
  },

  dismissContextChip: (sessionId) => {
    const next = new Set(get().dismissedContextChips)
    next.add(sessionId)
    set({ dismissedContextChips: next })
  },

  setMountPointThread: (el) => set({ mountPointThread: el }),
  setMountPointComposer: (el) => set({ mountPointComposer: el }),
}))

/** Internal: exposed for tests that want to reset between cases. */
export const __resetChatPanelStore = () => {
  useChatPanelStore.setState({
    isOpen: false,
    mode: 'thread',
    width: DEFAULT_PANEL_WIDTH,
    openSessionId: null,
    popped: false,
    returnTo: null,
    hasUnread: false,
    lastActionAt: 0,
    draftBySession: {},
    dismissedContextChips: new Set(),
    mountPointThread: null,
    mountPointComposer: null,
  })
}
