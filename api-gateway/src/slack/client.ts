// Thin wrapper around @slack/web-api so the route + handler files don't
// have to import the SDK directly. Uses chat.postMessage (replies),
// reactions.add/remove (the "Cyggie is working" 👀 indicator on the
// user's message), and slice 7 will add users.info (lazy Slack→Cyggie
// mapping).
//
// Factory pattern (not a singleton) so tests can mock per-instance.

import { WebClient } from '@slack/web-api'

export interface SlackClient {
  postMessage(args: {
    channel: string
    text: string
    threadTs?: string
  }): Promise<{ ok: boolean; ts?: string }>
  // Best-effort cosmetic indicators. These swallow Slack's benign
  // idempotency / scope errors and resolve { ok: false } rather than
  // throw — a missing reaction must never affect the answer.
  addReaction(args: {
    channel: string
    timestamp: string
    name: string
  }): Promise<{ ok: boolean }>
  removeReaction(args: {
    channel: string
    timestamp: string
    name: string
  }): Promise<{ ok: boolean }>
}

// Slack error strings we treat as success-equivalent (the desired end
// state already holds, or the scope simply isn't granted yet). Anything
// else propagates so the caller can log/Sentry it.
const BENIGN_REACTION_ERRORS = new Set([
  'already_reacted', // add: reaction already present
  'no_reaction', // remove: nothing to remove
  'message_not_found', // remove: original message gone
  'missing_scope', // reactions:write not granted yet (graceful degrade)
])

function reactionData(err: unknown): string | undefined {
  // @slack/web-api throws errors with a `.data.error` string field.
  const data = (err as { data?: { error?: string } } | undefined)?.data
  return data?.error
}

export function makeSlackClient(botToken: string): SlackClient {
  const web = new WebClient(botToken)
  return {
    async postMessage({ channel, text, threadTs }) {
      const res = await web.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
      return { ok: res.ok ?? false, ts: res.ts }
    },
    async addReaction({ channel, timestamp, name }) {
      try {
        const res = await web.reactions.add({ channel, timestamp, name })
        return { ok: res.ok ?? false }
      } catch (err) {
        if (BENIGN_REACTION_ERRORS.has(reactionData(err) ?? '')) {
          return { ok: false }
        }
        throw err
      }
    },
    async removeReaction({ channel, timestamp, name }) {
      try {
        const res = await web.reactions.remove({ channel, timestamp, name })
        return { ok: res.ok ?? false }
      } catch (err) {
        if (BENIGN_REACTION_ERRORS.has(reactionData(err) ?? '')) {
          return { ok: false }
        }
        throw err
      }
    },
  }
}
