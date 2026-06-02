// `/cyggie <natural-language question>` handler (External Agents V1 slice 5).
//
// Routes any slash command or @-mention/DM text that isn't `search ...`
// through the cyggieAsk agent loop. Async response pattern:
//   1. Caller acks Slack with HTTP 200 + placeholder ("🤔 Looking that
//      up...") so we stay under Slack's 3s slash-command SLA.
//   2. We run cyggieAsk in the background.
//   3. POST the final answer back to Slack via response_url (slash
//      command) OR chat.postMessage (event).
//
// All paths Sentry-tagged on failure; categorized errors map to
// user-friendly messages per plan decision-log #22.

import type { FastifyBaseLogger } from 'fastify'
import type { getDb } from '../../db'
import type { GatewayEnv } from '../../env'
import { Sentry } from '../../sentry'
import {
  cyggieAsk,
  CyggieAskError,
  type CyggieAskErrorCode,
} from '../../services/chat-agent/cyggie-ask'
import { resolveAnthropicKey } from '../../llm/resolve-key'
import { markdownToMrkdwn } from '../markdown-to-mrkdwn'
import type { SlackClient } from '../client'

export const PLACEHOLDER_TEXT = ":thinking_face: Looking that up..."

export type AskTarget =
  | { kind: 'slash'; responseUrl: string }
  | { kind: 'event'; channel: string; threadTs?: string; client: SlackClient }

export interface RunSlackAskArgs {
  question: string
  userId: string
  env: GatewayEnv
  db: ReturnType<typeof getDb>
  log: FastifyBaseLogger
  target: AskTarget
  onBehalfOf?: { slackUserId?: string }
}

// Fire-and-forget background work. Callers do NOT await this — they ack
// Slack synchronously then this runs to completion in the event loop.
// Errors are caught + posted back to Slack; nothing should escape.
export function runSlackAskAsync(args: RunSlackAskArgs): void {
  // Wrap in an IIFE so the outer return type stays void and we can
  // .catch any escape.
  ;(async () => {
    const startedAt = Date.now()
    try {
      await runSlackAsk(args)
    } catch (err) {
      // This catch is the safety net — runSlackAsk should already have
      // posted a user-friendly error message. If we land here, the
      // error escaped the inner handler (extremely rare).
      args.log.error(
        { err, metric: 'slack.ask.unhandled', duration_ms: Date.now() - startedAt },
        'runSlackAskAsync escaped its own handler',
      )
      Sentry.captureException(err, {
        tags: { surface: 'slack_ask_outer' },
      })
    }
  })().catch(() => {
    // Last-resort no-op; the .catch above already logged.
  })
}

async function runSlackAsk(args: RunSlackAskArgs): Promise<void> {
  const { question, userId, env, db, log, target } = args
  const startedAt = Date.now()

  // Resolve the Anthropic key. Per plan decision-log #5: gateway's
  // shared env key for the service-account path. resolveAnthropicKey
  // already encapsulates the user_credentials → env fallback.
  const apiKey = await resolveAnthropicKey(env, userId)
  if (!apiKey) {
    await postReply(
      target,
      'Cyggie is missing an Anthropic API key. Ask the admin to configure one.',
    )
    log.error(
      { metric: 'slack.ask.fail', error_code: 'NO_ANTHROPIC_KEY' },
      'cyggieAsk skipped — no API key resolvable',
    )
    return
  }

  try {
    const result = await cyggieAsk({
      question,
      apiKey,
      db,
      userId,
      log,
      caller: 'slack',
      onBehalfOf: args.onBehalfOf,
    })
    const mrkdwn = markdownToMrkdwn(result.answer || '_(Cyggie returned an empty answer)_')
    await postReply(target, mrkdwn)
    log.info(
      {
        metric: 'slack.queries',
        ok: true,
        duration_ms: Date.now() - startedAt,
        iterations: result.iterationCount,
      },
      'slack ask completed',
    )
  } catch (err) {
    const friendly = categorizeForSlack(err)
    await postReply(target, friendly.message).catch((postErr) => {
      log.error(
        { err: postErr, metric: 'slack.ask.post_fail' },
        'failed to post error reply to Slack',
      )
    })
    log.warn(
      {
        err,
        metric: 'slack.ask.fail',
        error_code: friendly.code,
        duration_ms: Date.now() - startedAt,
      },
      'cyggieAsk failed',
    )
    Sentry.captureException(err, {
      tags: { surface: 'slack_ask', error_code: friendly.code },
    })
  }
}

interface FriendlyError {
  code: CyggieAskErrorCode | 'NO_ANTHROPIC_KEY' | 'UNKNOWN'
  message: string
}

// Map CyggieAskError categories → user-facing messages. Per plan
// decision-log #22 acceptance criteria.
function categorizeForSlack(err: unknown): FriendlyError {
  if (err instanceof CyggieAskError) {
    switch (err.code) {
      case 'RATE_LIMITED':
        return {
          code: 'RATE_LIMITED',
          message: 'Cyggie is overloaded right now — try again in a moment.',
        }
      case 'OVERLOADED':
      case 'UPSTREAM_TRANSIENT':
        return {
          code: err.code,
          message:
            'Cyggie hit a temporary error talking to the model. Please retry.',
        }
      case 'TIMEOUT':
        return {
          code: 'TIMEOUT',
          message:
            "That query took longer than expected (>60s). Try breaking it into smaller questions.",
        }
      case 'MAX_ITERATIONS':
        return {
          code: 'MAX_ITERATIONS',
          message:
            "Cyggie made too many tool calls without converging. Try a more specific question.",
        }
      case 'CONTENT_REFUSED':
        return {
          code: 'CONTENT_REFUSED',
          message: "Cyggie can't answer that question (content policy).",
        }
      case 'INVALID_INPUT':
        return {
          code: 'INVALID_INPUT',
          message: err.message || 'Invalid question.',
        }
      case 'INTERNAL':
      default:
        return {
          code: 'INTERNAL',
          message: 'Cyggie hit an unexpected error. We logged it.',
        }
    }
  }
  return {
    code: 'UNKNOWN',
    message: 'Cyggie hit an unexpected error. We logged it.',
  }
}

async function postReply(target: AskTarget, text: string): Promise<void> {
  if (target.kind === 'slash') {
    // Slash command — POST to response_url. Replaces our placeholder.
    const res = await fetch(target.responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        response_type: 'in_channel',
        text,
        mrkdwn: true,
      }),
    })
    if (!res.ok) {
      throw new Error(
        `Slack response_url POST failed: ${res.status} ${res.statusText}`,
      )
    }
    return
  }
  // Event (app_mention / message.im) — post via chat.postMessage. No
  // placeholder to replace because event handlers can't echo a response
  // body the way slash commands do.
  await target.client.postMessage({
    channel: target.channel,
    text,
    threadTs: target.threadTs,
  })
}
