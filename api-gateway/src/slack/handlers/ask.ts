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
import { recordAuditAsync } from '../../audit/buffer'
import {
  decideFocus,
  getFocus,
  loadFocusName,
  upsertFocus,
  type ThreadFocus,
} from '../thread-focus'
import {
  buildCompanyContextForChat,
  buildContactContextForChat,
} from '../../services/chat-agent/context-builders'

export const PLACEHOLDER_TEXT = ":thinking_face: Looking that up..."

// 👀 reaction added to the user's message on the event surface
// (app_mention / DM) while cyggieAsk runs, then removed when the answer
// (or error) posts. Signals "Cyggie is working on it" during the lag —
// slash commands don't need it (they already show PLACEHOLDER_TEXT).
// Swap to 'hourglass_flowing_sand' (⏳) for a more literal "working" glyph.
export const REACTION_NAME = 'eyes'

export type AskTarget =
  | { kind: 'slash'; responseUrl: string }
  | { kind: 'event'; channel: string; threadTs?: string; client: SlackClient }

export interface RunSlackAskArgs {
  question: string
  // Slice D: identity resolved upstream by resolveSlackIdentity (route.ts). The
  // handler no longer maps the Slack user itself — it trusts these.
  userId: string
  firmId: string | null
  // true when userId came from a REAL Slack→Cyggie mapping (audit attributes to
  // it); false for the beta default service-account user (attribute to null).
  mapped: boolean
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
    // "Cyggie is working" indicator. Added here — the single chokepoint
    // all event terminal paths flow through — so the finally guarantees
    // removal no matter how runSlackAsk exits. Best-effort: never blocks
    // or fails the answer.
    const reacted = await addThinkingReaction(args)
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
    } finally {
      if (reacted) await removeThinkingReaction(args)
    }
  })().catch(() => {
    // Last-resort no-op; the .catch above already logged.
  })
}

// Add the 👀 indicator to the user's message. Only applies to the event
// surface (app_mention / DM) where we have the message ts to react to;
// slash commands return undefined target.client and are skipped. Returns
// true only if the reaction was actually placed, so the caller knows
// whether there's anything to remove. All failures degrade silently —
// the reaction is cosmetic, not part of the answer.
async function addThinkingReaction(args: RunSlackAskArgs): Promise<boolean> {
  const { target, slackMessageTs } = args
  if (target.kind !== 'event' || !slackMessageTs) return false
  try {
    const res = await target.client.addReaction({
      channel: target.channel,
      timestamp: slackMessageTs,
      name: REACTION_NAME,
    })
    return res.ok
  } catch (err) {
    args.log.warn(
      { err, metric: 'slack.reaction.add_fail' },
      'failed to add working-indicator reaction — continuing',
    )
    Sentry.captureException(err, { tags: { surface: 'slack_reaction_add' } })
    return false
  }
}

// Mirror of addThinkingReaction — remove the indicator once the answer or
// error has posted. Best-effort; a leftover reaction is harmless.
async function removeThinkingReaction(args: RunSlackAskArgs): Promise<void> {
  const { target, slackMessageTs } = args
  if (target.kind !== 'event' || !slackMessageTs) return
  try {
    await target.client.removeReaction({
      channel: target.channel,
      timestamp: slackMessageTs,
      name: REACTION_NAME,
    })
  } catch (err) {
    args.log.warn(
      { err, metric: 'slack.reaction.remove_fail' },
      'failed to remove working-indicator reaction — leaving it',
    )
    Sentry.captureException(err, { tags: { surface: 'slack_reaction_remove' } })
  }
}

async function runSlackAsk(args: RunSlackAskArgs): Promise<void> {
  const { question, env, db, log, target } = args
  const startedAt = Date.now()
  // Slice D: identity (userId, firmId, mapped) is resolved upstream by
  // resolveSlackIdentity (route.ts) with the fail-closed rule. The handler
  // trusts it — no mapping or firm lookup here. `mapped` drives audit
  // attribution (only credit a real mapped user, never the beta default).
  const { userId, firmId, mapped: resolvedMapped } = args
  const slackUserId = args.onBehalfOf?.slackUserId

  // Resolve the Anthropic key. resolveAnthropicKey is firm-gated (Slice A): the
  // shared env key is only honoured for the beta firm, so we pass the identity's
  // firm. The beta-workspace default user is in the beta firm, so RS's
  // service-account path keeps working.
  const apiKey = await resolveAnthropicKey(env, userId, firmId)
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

  // Part 2: if this thread has a warm focus and the follow-up is about that
  // same entity (or a pure anaphor), pre-inject its context so the agent
  // doesn't re-fetch it — and the cache_control'd segment makes it a cheap
  // cache read. A different-entity follow-up skips injection (no stale
  // context). All of this is best-effort: any failure falls through to the
  // normal stateless loop (the invariant).
  let focusBlock: string | undefined
  let reusedFocus: ThreadFocus | undefined
  if (sessionId) {
    const inj = await computeFocusInjection({ db, userId, question, sessionId, log })
    focusBlock = inj.block
    reusedFocus = inj.reused
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
      // Firm scope for note visibility — resolved upstream (Slice D).
      firmId,
      log,
      caller: 'slack',
      onBehalfOf: args.onBehalfOf,
      conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
      focusContextBlock: focusBlock,
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

  // Part 2: persist this thread's focus. The authoritative entity is whatever
  // cyggie_get_context actually loaded (1A); on a pure-reuse turn the agent
  // didn't reload, so we just touch the reused focus to keep it warm. Fire-and-
  // forget — the user already has the answer; a failed write only costs the
  // next follow-up its cache hit.
  if (sessionId) {
    const persist = result.loadedFocus ?? reusedFocus ?? null
    if (persist) {
      void upsertFocus(db, {
        sessionId,
        entityType: persist.entityType,
        entityId: persist.entityId,
      }).catch((focusErr) => {
        log.warn(
          { err: focusErr, metric: 'slack.focus.persist_fail', sessionId },
          'failed to upsert slack thread focus',
        )
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
      focus_reused: reusedFocus ? reusedFocus.entityType : null,
      focus_loaded: result.loadedFocus ? result.loadedFocus.entityType : null,
    },
  })
}

// Part 2 — best-effort focus pre-check. Loads the thread's stored focus +
// its display name, asks decideFocus whether to reuse it, and (on reuse)
// rebuilds the entity's context block via the same builders the detail-page
// chat uses. Any failure returns {} so the ask falls through to the normal
// stateless loop (the silent-degradation invariant).
async function computeFocusInjection(args: {
  db: ReturnType<typeof getDb>
  userId: string
  question: string
  sessionId: string
  log: FastifyBaseLogger
}): Promise<{ block?: string; reused?: ThreadFocus }> {
  const { db, userId, question, sessionId, log } = args
  try {
    const currentFocus = await getFocus(db, sessionId)
    if (!currentFocus) return {}
    const focusName = await loadFocusName(db, currentFocus, userId)
    const decision = decideFocus({ question, currentFocus, focusName, nowMs: Date.now() })
    log.info(
      {
        metric: 'slack.focus',
        decision: decision.action,
        focus_type: currentFocus.entityType,
        entity_id: currentFocus.entityId,
      },
      'slack focus decision',
    )
    if (decision.action !== 'reuse' || !decision.injectFocus) return {}
    const f = decision.injectFocus
    const block =
      f.entityType === 'company'
        ? await buildCompanyContextForChat(db, f.entityId, userId)
        : await buildContactContextForChat(db, f.entityId, userId)
    // Entity deleted since the focus was set → nothing to inject; skip rather
    // than error the turn.
    if (!block) return {}
    return { block, reused: f }
  } catch (focusErr) {
    log.warn(
      { err: focusErr, metric: 'slack.focus.fail', sessionId },
      'focus injection failed — continuing without it',
    )
    Sentry.captureException(focusErr, { tags: { surface: 'slack_focus' } })
    return {}
  }
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
