/**
 * Unified chat dispatch — single entry point for every chat surface.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ IPC handlers (5 channels: meeting / meetings / company /     │
 *   │   contact / global) all delegate here in step 9.             │
 *   └────────────────────┬────────────────────────────────────────┘
 *                        ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ chatDispatch({ kind, question, attachments }): Promise<str> │
 *   │   switch on kind.kind:                                       │
 *   │     'meeting'   → queryMeeting                               │
 *   │     'meetings'  → querySearchResults                         │
 *   │     'company'   → queryCompany                               │
 *   │     'contact'   → queryContact                               │
 *   │     'global'    → queryAll                                   │
 *   │   default       → never-guard throws TypeError                │
 *   └────────────────────┬────────────────────────────────────────┘
 *                        ▼
 *   Each query* function already delegates to runChatTurn with its
 *   own assemble + buildContext pair (steps 3-7). chatDispatch just
 *   routes by kind; the real work lives in context-builders.ts.
 *
 *   abortChatDispatch() = abortChatTurn() — single shared controller.
 */

import { abortChatTurn } from './chat-runner'
import { queryMeeting, querySearchResults } from './chat'
import { queryCompany } from './company-chat'
import { queryContact } from './contact-chat'
import { queryAll } from './crm-chat'
import type { ChatAttachment } from '../../shared/types/chat'

// Kind shape matches the renderer-side ChatKind in lib/chat-channels.ts.
// Keep these in sync — the 5 IPC channels select via the renderer's lookup.
export type ChatKind =
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'meetings'; meetingIds: string[] }
  | { kind: 'company'; companyId: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'global' }

export interface ChatDispatchArgs {
  kind: ChatKind
  question: string
  attachments?: ChatAttachment[]
}

export async function chatDispatch(args: ChatDispatchArgs): Promise<string> {
  const k = args.kind
  switch (k.kind) {
    case 'meeting':
      return queryMeeting(k.meetingId, args.question, args.attachments ?? [])
    case 'meetings':
      return querySearchResults(k.meetingIds, args.question, args.attachments ?? [])
    case 'company':
      return queryCompany(k.companyId, args.question, args.attachments)
    case 'contact':
      return queryContact(k.contactId, args.question, args.attachments)
    case 'global':
      return queryAll(args.question, args.attachments ?? [])
    default: {
      const _exhaustive: never = k
      throw new Error(`unknown ChatKind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** Abort whichever turn is currently in flight. Single shared
 *  AbortController across all kinds (per chat-runner's invariant). */
export function abortChatDispatch(): void {
  abortChatTurn()
}
