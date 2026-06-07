// cyggie_get_context — fetch the full working context for ONE company or
// contact: the entity's recent meetings rendered with notes + AI summary +
// transcript (and flagged documents for companies). This is the SAME context
// the in-app detail-page chat assembles — it reuses the single-source-of-truth
// builders so the Slack/MCP surface and the in-product chat never drift.
//
// Unlike the other lookup tools this one takes a resolved cuid2 id, not a
// free-form name: the caller resolves the entity first (via cyggie_search /
// cyggie_get_company / cyggie_get_contact, all of which return the id) and then
// asks for its deep context here.

import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import {
  buildCompanyContextForChat,
  buildContactContextForChat,
} from '../../services/chat-agent/context-builders'
import { cyggieUrl } from '../format'

// Identifies which entity a get_context call actually loaded. Surfaced back up
// the agent loop (cyggieAsk → ask.ts) so the Slack handler can persist the
// thread focus from what was *actually* loaded (Part 2, capture flow 1A).
export type LoadedFocus = { entityType: 'company' | 'contact'; entityId: string }

export interface CyggieGetContextArgs {
  db: ReturnType<typeof getDb>
  userId: string
  // At most ONE of companyId/contactId. cuid2 ids, not names — resolve first.
  companyId?: string
  contactId?: string
  // Optional sink: when provided, the tool records the entity it loaded here so
  // the agent loop can read it off ToolCtx after the call returns (1A).
  onLoadedFocus?: (focus: LoadedFocus) => void
}

export async function cyggieGetContext(args: CyggieGetContextArgs): Promise<ToolResult> {
  const { db, userId, companyId, contactId } = args

  if (companyId && contactId) {
    return err(
      ERROR_CODE.INVALID_INPUT,
      'Pass at most one of companyId or contactId; not both.',
    )
  }
  if (!companyId && !contactId) {
    return err(
      ERROR_CODE.INVALID_INPUT,
      'Pass a companyId or contactId (resolve the entity first via cyggie_search / cyggie_get_company / cyggie_get_contact).',
    )
  }

  if (companyId) {
    const block = await buildCompanyContextForChat(db, companyId, userId)
    if (block === null) {
      return err(
        ERROR_CODE.NOT_FOUND,
        `No company with id "${companyId}" (it may have been deleted, or the id is wrong).`,
      )
    }
    args.onLoadedFocus?.({ entityType: 'company', entityId: companyId })
    return ok(block, cyggieUrl('company', companyId))
  }

  // contactId branch (guaranteed set by the guards above).
  const id = contactId as string
  const block = await buildContactContextForChat(db, id, userId)
  if (block === null) {
    return err(
      ERROR_CODE.NOT_FOUND,
      `No contact with id "${id}" (it may have been deleted, or the id is wrong).`,
    )
  }
  args.onLoadedFocus?.({ entityType: 'contact', entityId: id })
  return ok(block, cyggieUrl('contact', id))
}
