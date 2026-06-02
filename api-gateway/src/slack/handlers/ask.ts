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
import {
  appendSlackTurn,
  findOrCreateSlackSession,
  loadSlackSessionMessages,
  type SlackThreadKey,
} from '../thread-session'
import { resolveSlackUser } from '../user-mapping'
import { recordAuditAsync } from '../../audit/buffer'

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
  // Slice 6: thread key for find-or-create session lookup. If omitted,
  // the ask runs stateless (no prior-turn context, no persistence).
  // Slash commands omit this for now — slash queries are one-shots
  // that don't have a Slack thread to anchor to. App-mention + DM
  // events pass it for continuity.
  threadKey?: SlackThreadKey
  // Slice 7: source Slack message ts for forensic audit lookup
  // ("the bot answered weirdly at 3pm yesterday").
  slackMessageTs?: string
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
  const { question, env, db, log, target } = args
  const startedAt = Date.now()
  // Slice 7: attempt to upgrade the env-default user to a properly
  // mapped Cyggie user via Slack users.info. The env default is the
  // V1 fallback; mapping enriches audit attribution and (eventually)
  // per-user scoping. Failures degrade gracefully — mapping is
  // enrichment, not gating (plan Q7).
  let userId = args.userId
  let resolvedMapped = false
  const slackUserId = args.onBehalfOf?.slackUserId
  const workspaceId = args.threadKey?.workspaceId
  if (slackUserId && workspaceId && env.SLACK_BOT_TOKEN) {
    try {
      const mapped = await resolveSlackUser({
        db,
        workspaceId,
        slackUserId,
        slackBotToken: env.SLACK_BOT_TOKEN,
        log,
      })
      if (mapped.kind === 'mapped') {
        userId = mapped.cyggieUserId
        resolvedMapped = true
      } else if (mapped.kind === 'bot_token_revoked') {
        await postReply(
          target,
          'Cyggie bot is misconfigured — please notify the admin.',
        )
        recordAuditAsync({
          surface: 'slack',
          toolName: 'cyggie_ask',
          onBehalfOfSlackId: slackUserId,
          slackMessageTs: args.slackMessageTs ?? null,
          ok: false,
          errorCode: 'SLACK_TOKEN_REVOKED',
          durationMs: Date.now() - startedAt,
          inputSummary: truncate(question, 200),
        })
        return
      }
      // 'unmapped' / 'transient_failure' → fall through with the env
      // default userId. Audit row will note slack id but the cyggie
      // id is the default (best-effort).
    } catch (mappingErr) {
      log.warn(
        { err: mappingErr, metric: 'slack.user_mapping.fail' },
        'slack user mapping failed — using fallback userId',
      )
      Sentry.captureException(mappingErr, {
        tags: { surface: 'slack_user_mapping' },
      })
    }
  }

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
    recordAuditAsync({
      surface: 'slack',
      toolName: 'cyggie_ask',
      onBehalfOfUserId: resolvedMapped ? userId : null,
      onBehalfOfSlackId: slackUserId ?? null,
      slackMessageTs: args.slackMessageTs ?? null,
      ok: false,
      errorCode: 'NO_ANTHROPIC_KEY',
      durationMs: Date.now() - startedAt,
      inputSummary: truncate(question, 200),
    })
    return
  }

  // Slice 6: resolve the Slack-thread → chat_sessions row up front so
  // prior turns are loaded as conversationContext. find-or-create
  // returns a stable session id even under concurrent first-message
  // races (loser re-reads winner's row). Failure here doesn't block
  // the answer — we run stateless and log.
  let sessionId: string | null = null
  let conversationContext: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (args.threadKey) {
    try {
      const session = await findOrCreateSlackSession({
        db,
        userId,
        key: args.threadKey,
      })
      sessionId = session.id
      if (!session.isNew) {
        conversationContext = await loadSlackSessionMessages({
          db,
          sessionId: session.id,
        })
      }
    } catch (sessionErr) {
      log.warn(
        { err: sessionErr, metric: 'slack.session.fail' },
        'slack thread session lookup failed — continuing stateless',
      )
      Sentry.captureException(sessionErr, {
        tags: { surface: 'slack_thread_session' },
      })
    }
  }

  // The ask flow has three distinct failure surfaces. We catch each
  // separately so the audit row records the actual failing layer
  // instead of conflating "cyggieAsk threw" with "Slack rejected our
  // post-back" (the latter would otherwise surface as a generic
  // INTERNAL code, hiding what's actually wrong from the operator).
  let result: Awaited<ReturnType<typeof cyggieAsk>> | null = null
  try {
    result = await cyggieAsk({
      question,
      apiKey,
      db,
      userId,
      log,
      caller: 'slack',
      onBehalfOf: args.onBehalfOf,
      conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
    })
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
    recordAuditAsync({
      surface: 'slack',
      toolName: 'cyggie_ask',
      onBehalfOfUserId: resolvedMapped ? userId : null,
      onBehalfOfSlackId: slackUserId ?? null,
      slackMessageTs: args.slackMessageTs ?? null,
      ok: false,
      errorCode: friendly.code,
      durationMs: Date.now() - startedAt,
      inputSummary: truncate(question, 200),
    })
    return
  }

  const mrkdwn = markdownToMrkdwn(result.answer || '_(Cyggie returned an empty answer)_')
  try {
    await postReply(target, mrkdwn)
  } catch (postErr) {
    // cyggieAsk succeeded but Slack rejected the post-back (e.g.
    // response_url 5xx, 429 after SDK retries exhausted, AbortController
    // timeout). The user never saw the answer; audit must reflect that
    // distinctly so forensic lookup by slack_message_ts isn't misleading.
    log.error(
      {
        err: postErr,
        metric: 'slack.ask.post_fail',
        duration_ms: Date.now() - startedAt,
        iterations: result.iterationCount,
      },
      'cyggieAsk succeeded but post-reply to Slack failed',
    )
    Sentry.captureException(postErr, {
      tags: { surface: 'slack_post_reply', error_code: 'SLACK_POST_FAILED' },
    })
    recordAuditAsync({
      surface: 'slack',
      toolName: 'cyggie_ask',
      onBehalfOfUserId: resolvedMapped ? userId : null,
      onBehalfOfSlackId: slackUserId ?? null,
      slackMessageTs: args.slackMessageTs ?? null,
      ok: false,
      errorCode: 'SLACK_POST_FAILED',
      durationMs: Date.now() - startedAt,
      inputSummary: truncate(question, 200),
      outputSize: mrkdwn.length,
      extras: {
        iterations: result.iterationCount,
        session_id: sessionId,
        prior_turns: conversationContext.length,
      },
    })
    return
  }

  // Persist the new turn pair so follow-ups in this thread have
  // context. Errors here are non-fatal — the user already saw the
  // answer; missing the persistence just means the next follow-up
  // won't have this turn in its history. The audit stays ok=true.
  if (sessionId && result.answer) {
    try {
      await appendSlackTurn({
        db,
        sessionId,
        userText: question,
        assistantText: result.answer,
      })
    } catch (persistErr) {
      log.warn(
        { err: persistErr, metric: 'slack.session.persist_fail', sessionId },
        'failed to persist slack turn pair — follow-ups will miss context',
      )
      Sentry.captureException(persistErr, {
        tags: { surface: 'slack_turn_persist' },
      })
    }
  }

  log.info(
    {
      metric: 'slack.queries',
      ok: true,
      duration_ms: Date.now() - startedAt,
      iterations: result.iterationCount,
      sessionId,
      prior_turns: conversationContext.length,
    },
    'slack ask completed',
  )
  recordAuditAsync({
    surface: 'slack',
    toolName: 'cyggie_ask',
    onBehalfOfUserId: resolvedMapped ? userId : null,
    onBehalfOfSlackId: slackUserId ?? null,
    slackMessageTs: args.slackMessageTs ?? null,
    ok: true,
    durationMs: Date.now() - startedAt,
    inputSummary: truncate(question, 200),
    outputSize: result.answer.length,
    extras: {
      iterations: result.iterationCount,
      session_id: sessionId,
      prior_turns: conversationContext.length,
    },
  })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
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

// 10s is generous — Slack's response_url is normally <500ms. We pick a
// value short enough that a hung request can't pile up promises across
// many in-flight asks, but long enough to absorb transient network
// blips without false-aborting healthy posts.
const POST_REPLY_TIMEOUT_MS = 10_000

async function postReply(target: AskTarget, text: string): Promise<void> {
  if (target.kind === 'slash') {
    // Slash command — POST to response_url. Replaces our placeholder.
    // AbortController bounds the fetch; without it, undici's default
    // (~5 min) means a degraded response_url could leave a runSlackAsk
    // promise hanging well past the agent loop's 60s cap.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POST_REPLY_TIMEOUT_MS)
    try {
      const res = await fetch(target.responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          response_type: 'in_channel',
          text,
          mrkdwn: true,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(
          `Slack response_url POST failed: ${res.status} ${res.statusText}`,
        )
      }
    } finally {
      clearTimeout(timeoutId)
    }
    return
  }
  // Event (app_mention / message.im) — post via chat.postMessage. No
  // placeholder to replace because event handlers can't echo a response
  // body the way slash commands do. The @slack/web-api SDK enforces
  // its own request timeout (60s default) and retries 429s with
  // backoff, so we don't wrap it here.
  await target.client.postMessage({
    channel: target.channel,
    text,
    threadTs: target.threadTs,
  })
}
