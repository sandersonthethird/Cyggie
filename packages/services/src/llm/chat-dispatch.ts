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
import { queryEntities, buildUnifiedEntitiesContext, type EntityRef } from './entities-chat'
import type { ChatAttachment } from '@shared/types/chat'

// Kind shape matches the renderer-side ChatKind in lib/chat-channels.ts.
// Keep these in sync — the IPC channels select via the renderer's lookup.
// NOTE: company/contact are still valid service kinds (queryEntities reuses
// queryCompany/queryContact internally for the single-entity case), but the
// renderer no longer emits them — it routes every attached-entity chat through
// the unified `entities` kind.
export type ChatKind =
  | { kind: 'meeting'; meetingId: string; refs?: EntityRef[] }
  | { kind: 'meetings'; meetingIds: string[] }
  | { kind: 'company'; companyId: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'entities'; refs: EntityRef[] }
  | { kind: 'global' }

export interface ChatDispatchArgs {
  kind: ChatKind
  question: string
  attachments?: ChatAttachment[]
}

export async function chatDispatch(args: ChatDispatchArgs): Promise<string> {
  const k = args.kind
  switch (k.kind) {
    case 'meeting': {
      // When the user attached companies/contacts to a meeting chat, resolve
      // their deduped context here (this layer already imports entities-chat) and
      // hand it to queryMeeting as ready markdown. The viewed meeting is excluded
      // from the attached set so it isn't duplicated (full above + 3k snippet here).
      const refs = k.refs ?? []
      const attachedContext =
        refs.length > 0
          ? (await buildUnifiedEntitiesContext(refs, { excludeMeetingId: k.meetingId })).markdown
          : null
      return queryMeeting(k.meetingId, args.question, args.attachments ?? [], attachedContext)
    }
    case 'meetings':
      return querySearchResults(k.meetingIds, args.question, args.attachments ?? [])
    case 'company':
      return queryCompany(k.companyId, args.question, args.attachments)
    case 'contact':
      return queryContact(k.contactId, args.question, args.attachments)
    case 'entities':
      return queryEntities(k.refs, args.question, args.attachments)
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
