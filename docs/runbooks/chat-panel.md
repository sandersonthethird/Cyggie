# AI Chat Panel — runbook

The AI chat panel is the persistent right-rail surface introduced to replace
the floating bottom-pill `ChatInterface` and the `⌘H` chat-history modal. This
runbook covers the most common ways the panel can break and how to recover.

---

## Architecture cheatsheet

```
useChatPanelStore (Zustand)
   │  isOpen / mode / width / popped / openSessionId / hasUnread
   │  draftBySession / dismissedContextChips / returnTo / lastActionAt
   │  mountPointThread / mountPointComposer  ← portal targets (set by Rail/Fullscreen)
   │
   ▼
<ChatPanelRoot/>  (singleton, mounted by Layout.tsx)
   │  hydrates session on mount, owns useChatStreaming
   │  renders <PanelThread/> + <PanelComposer/> ONCE, portaled into:
   │    • mountPointThread / mountPointComposer  (from store)
   │
   ▼
<AIChatPanel/>     OR     <AIChatFullscreen/>
  (rail, in body)         (route /ai-chats/:id)
   provides slot divs that register as the active mount points
```

Logging prefixes:

- `[chat-panel]` — provider mount, hydrate timing, popout, minimize, mode switch
- `[chat-streaming]` — turn start, turn end, error, abort, watchdog fire
- `[safe-storage]` — JSON.parse failures, quota evictions, security fallbacks

---

## Failure modes

### 1. Panel won't open

**Symptom:** clicking the AI Chat toggle in the titlebar (or pressing ⌘J)
does nothing visible.

**Diagnosis:**

1. Open DevTools → Console.
2. Look for `[safe-storage]` errors. Corrupted localStorage values
   (e.g. `cyggie:chat:width = "garbage"`) cause `loadPersistedState` to fall
   back to defaults but should not block opening.
3. Look for `[chat-panel] hydrate` errors. If `CHAT_SESSION_GET_FOR_CONTEXT`
   or `CHAT_SESSION_LIST_RECENT` rejects, the panel still opens with an
   empty thread.

**Recovery:**

```js
// In DevTools console (renderer):
localStorage.removeItem('cyggie:chat:open')
localStorage.removeItem('cyggie:chat:width')
localStorage.removeItem('cyggie:chat:mode')
localStorage.removeItem('cyggie:chat:lastChatId')
location.reload()
```

If the panel still doesn't toggle, confirm `<ChatToggle/>` is mounted in
the titlebar (`Layout.tsx`) and `<ChatPanelRoot/>` is rendered as a sibling
of the titlebar.

---

### 2. Stuck on "Thinking…" (stream never completes)

**Symptom:** after sending a message, the dots animation persists; no
assistant response ever appears; the abort button doesn't recover.

**Diagnosis:**

1. The 60-second watchdog inside `useChatStreaming` should fire automatically
   if no `CHAT_PROGRESS` chunk arrives. Look for:
   `[chat-streaming] watchdog fired — aborting stalled stream`
2. If the watchdog hasn't fired but should have, check `stallTimeoutMs` —
   only `0` disables it. Default is `60_000`.
3. If chunks ARE arriving but the final invoke never resolves, this is a
   main-process issue. Look for the matching turn in main-process logs.

**Recovery:**

- Click the `■` (stop) button in the composer to call abort manually.
- If the abort itself fails (`[chat-streaming] abort failed`), the abort
  channel mapping in `lib/chat-channels.ts` may be wrong for this kind. The
  abort error is rescued; UI state (isLoading) resets regardless.
- Last resort: hard-reload the renderer (`⌘R` in dev / `View → Force Reload`
  in production).

---

### 3. Pinned chat doesn't appear in the AIChats list

**Symptom:** user pins / renames / archives a chat from the side panel;
the AIChats list page (open in another window or visible behind the panel)
doesn't reflect the change.

**Diagnosis:**

The list page subscribes to two refresh triggers:

1. `window.focus` — refetches when the user clicks back into the window.
2. `useChatPanelStore.lastActionAt` — bumped by every panel mutation
   (`bumpAction()`).

If the list isn't refreshing, the panel mutation likely didn't call
`bumpAction()`. Look for `[chat-panel]` log entries near the action.

**Recovery:**

- Click the AIChats list area to refocus the window — refetch will fire.
- Verify `bumpAction()` is called inside the action handler that was used.
  See `useChatActions` consumers in `AIChatPanel.tsx` and `ChatPanelRoot.tsx`.

---

## Adding a new failure mode

When you encounter or build a new edge case:

1. Add a structured log entry with one of the existing prefixes.
2. If the user-visible state can break, add a "what the user sees" recovery
   path here.
3. If the failure is recoverable, ensure `useChatStreaming`'s centralized
   try/catch envelope handles it — don't leave silent rejections in the call
   sites.
