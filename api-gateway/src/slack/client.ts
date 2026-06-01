// Thin wrapper around @slack/web-api so the route + handler files don't
// have to import the SDK directly. Slice 1 only uses chat.postMessage;
// slice 5 will add reactions.add (for the loading-emoji UX) and slice 7
// will add users.info (for lazy Slack→Cyggie mapping).
//
// Factory pattern (not a singleton) so tests can mock per-instance.

import { WebClient } from '@slack/web-api'

export interface SlackClient {
  postMessage(args: {
    channel: string
    text: string
    threadTs?: string
  }): Promise<{ ok: boolean; ts?: string }>
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
  }
}
