// POST /slack/events — slice 1 scaffold for the Cyggie Slack bot.
//
// One endpoint serves three Slack-side surfaces:
//   1. URL verification (Slack pings us once when we save the manifest;
//      we echo the `challenge` field back). Slack ONLY pings during
//      manifest setup so this path runs rarely — but if we don't
//      handle it, Slack rejects the URL.
//   2. Slash commands (application/x-www-form-urlencoded) — Slack sends
//      `command='/cyggie'` etc. We respond synchronously with JSON
//      `{ response_type, text }` which Slack renders inline.
//   3. Event subscriptions (application/json) — app_mention and
//      message.im in V1. We must ack with 200 within 3 seconds and
//      then post the reply async via chat.postMessage.
//
// Signature verification runs BEFORE JSON parsing for both content
// types — the raw body is captured into req.slackRawBody by a
// per-plugin content-type parser so the HMAC base string matches
// what Slack signed.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GatewayEnv } from '../env'
import { Sentry } from '../sentry'
import {
  checkSlackEventsRateLimit,
  registerSlackRateLimiter,
} from './rate-limit'
import { verifySlackSignature } from './signing'
import { makeSlackClient, type SlackClient } from './client'

// Custom Fastify request property: raw body string captured before parse.
// Augment via module declaration so handlers see it typed.
declare module 'fastify' {
  interface FastifyRequest {
    slackRawBody?: string
  }
}

const SLACK_BODY_LIMIT = 10 * 1024 // 10 KB
const HELLO_TEXT = "Hello! I'm Cyggie."

export interface RegisterSlackRoutesArgs {
  app: FastifyInstance
  env: GatewayEnv
}

export async function registerSlackRoutes(
  args: RegisterSlackRoutesArgs,
): Promise<void> {
  const { app, env } = args

  if (!env.CYGGIE_SLACK_ENABLED) {
    app.log.info(
      { flag: 'CYGGIE_SLACK_ENABLED' },
      'Slack route disabled by feature flag',
    )
    return
  }

  // Register the IP-based rate-limiter sweeper (independent from OAuth's).
  registerSlackRateLimiter(app)

  // Per-plugin content-type parsers capture the raw body string so the
  // signature verify can compute the HMAC over exactly what Slack
  // signed. Scoping to a child plugin keeps these parsers from
  // intercepting other gateway routes (mobile sync, chat) which expect
  // Fastify's default JSON behavior.
  await app.register(async (slackPlugin) => {
    slackPlugin.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: SLACK_BODY_LIMIT },
      (req, body, done) => {
        ;(req as FastifyRequest).slackRawBody = body as string
        try {
          done(null, body.length > 0 ? JSON.parse(body as string) : {})
        } catch (err) {
          done(err as Error)
        }
      },
    )

    slackPlugin.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: SLACK_BODY_LIMIT },
      (req, body, done) => {
        ;(req as FastifyRequest).slackRawBody = body as string
        const parsed = Object.fromEntries(
          new URLSearchParams(body as string).entries(),
        )
        done(null, parsed)
      },
    )

    // Lazy Slack client — only constructed when we actually need to
    // post a message back. If SLACK_BOT_TOKEN is absent, the app_mention
    // / message.im handlers can still ack 200 (so Slack doesn't retry
    // forever) but they log a warn and skip the reply.
    let slackClient: SlackClient | null = null
    function getClient(): SlackClient | null {
      if (slackClient) return slackClient
      if (!env.SLACK_BOT_TOKEN) return null
      slackClient = makeSlackClient(env.SLACK_BOT_TOKEN)
      return slackClient
    }

    slackPlugin.post('/slack/events', async (req, reply) => {
      // ─── 1. Rate limit ───────────────────────────────────────────
      const rate = checkSlackEventsRateLimit(req.ip)
      if (!rate.allowed) {
        req.log.warn(
          {
            metric: 'slack.rate_limit',
            ip: req.ip,
            retry_after_s: rate.retryAfterSeconds,
          },
          'slack rate limit exceeded',
        )
        return reply
          .code(429)
          .header('Retry-After', String(rate.retryAfterSeconds))
          .send({
            error: {
              code: 'RATE_LIMITED',
              message: `Too many Slack requests. Retry in ${rate.retryAfterSeconds}s.`,
            },
          })
      }

      // ─── 2. Signing prerequisite ─────────────────────────────────
      // If the env var is absent, the route fails-closed — no way to
      // verify, so no way to trust the payload.
      if (!env.SLACK_SIGNING_SECRET) {
        req.log.error(
          { metric: 'slack.auth.fail', error_code: 'AUTH_NOT_CONFIGURED' },
          'SLACK_SIGNING_SECRET not set — every Slack request 401s',
        )
        return reply.code(401).send({
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'Slack signing secret not configured on the gateway.',
          },
        })
      }

      // ─── 3. Signing verify ───────────────────────────────────────
      const signature = req.headers['x-slack-signature'] as
        | string
        | undefined
      const timestamp = req.headers['x-slack-request-timestamp'] as
        | string
        | undefined
      const rawBody = req.slackRawBody ?? ''

      // Sentry breadcrumb on every entry with sanitized headers — never
      // log the signature value itself, just whether it was present.
      Sentry.addBreadcrumb({
        category: 'slack-events',
        level: 'info',
        message: 'POST /slack/events',
        data: {
          has_signature: !!signature,
          has_timestamp: !!timestamp,
          content_type: req.headers['content-type'],
          ip: req.ip,
        },
      })

      const verify = verifySlackSignature({
        signingSecret: env.SLACK_SIGNING_SECRET,
        signature,
        timestamp,
        rawBody,
      })
      if (!verify.ok) {
        req.log.warn(
          {
            metric: 'slack.auth.fail',
            error_code: verify.reason,
            ip: req.ip,
          },
          'slack signature verify failed',
        )
        Sentry.captureMessage('Slack signature verify failed', {
          tags: { security: 'slack_sig_failure', reason: verify.reason },
          level: 'warning',
          extra: {
            ip: req.ip,
            ua: req.headers['user-agent'],
            ts_skew_seconds: timestamp
              ? Math.round(
                  Math.abs(Date.now() - Number.parseInt(timestamp, 10) * 1000) /
                    1000,
                )
              : null,
          },
        })
        return reply.code(401).send({
          error: {
            code: 'SLACK_SIGNATURE_INVALID',
            message: `Slack request signature failed: ${verify.reason}`,
          },
        })
      }

      // ─── 4. Dispatch based on payload shape ──────────────────────
      const body = req.body as Record<string, unknown>

      // URL verification ping — Slack only sends this during manifest
      // setup. Echo `challenge` per the Events API contract.
      if (body['type'] === 'url_verification') {
        req.log.info(
          { metric: 'slack.url_verification' },
          'slack url verification challenge',
        )
        return reply.send({ challenge: body['challenge'] })
      }

      // Slash command — form-encoded body, command field set.
      if (typeof body['command'] === 'string' && body['command']) {
        const cmd = body['command'] as string
        const text = String(body['text'] ?? '').trim()
        req.log.info(
          {
            metric: 'slack.slash_command',
            command: cmd,
            user_id: body['user_id'],
            channel_id: body['channel_id'],
            text_len: text.length,
          },
          'slack slash command received',
        )
        // Slice 1: every command returns the hello message. Slices 2/5
        // route based on text → search vs NL question.
        return reply.send({
          response_type: 'in_channel',
          text: HELLO_TEXT,
        })
      }

      // Event callback — wraps app_mention, message.im, etc.
      if (body['type'] === 'event_callback') {
        const event = body['event'] as
          | { type?: string; channel?: string; ts?: string; user?: string; bot_id?: string; subtype?: string }
          | undefined
        const eventType = event?.type

        // Slice 1: only respond to app_mention + DM message.im.
        // Ignore the bot's own messages (Slack echoes them back via
        // message.im sometimes; bot_id / subtype='bot_message' filter
        // those out).
        const isBotMessage =
          !!event?.bot_id || event?.subtype === 'bot_message'
        const isUserMention =
          eventType === 'app_mention' && !isBotMessage
        const isDmFromUser =
          eventType === 'message' && !isBotMessage && !event?.subtype

        if (isUserMention || isDmFromUser) {
          // Ack immediately; reply async so we don't bust Slack's 3s
          // SLA on tail-latency days.
          reply.code(200).send()
          const channel = event?.channel
          if (!channel) {
            req.log.warn({ eventType }, 'slack event missing channel')
            return
          }
          const client = getClient()
          if (!client) {
            req.log.warn(
              {
                metric: 'slack.client.unavailable',
                reason: 'SLACK_BOT_TOKEN missing',
                eventType,
              },
              'slack reply skipped — bot token not configured',
            )
            return
          }
          // Fire-and-forget. Errors land in Sentry via the catch but
          // don't block the already-sent 200 ack.
          client
            .postMessage({ channel, text: HELLO_TEXT })
            .then(() => {
              req.log.info(
                { metric: 'slack.reply.sent', eventType, channel },
                'slack reply posted',
              )
            })
            .catch((err) => {
              req.log.error(
                { err, metric: 'slack.reply.error', eventType, channel },
                'slack chat.postMessage failed',
              )
              Sentry.captureException(err, {
                tags: { surface: 'slack_reply', event_type: eventType },
              })
            })
          return
        }

        // Other event types we're subscribed to but not handling in
        // slice 1 (e.g. our own bot's message echo). Ack and move on.
        req.log.info(
          { metric: 'slack.event.ignored', eventType, isBotMessage },
          'slack event ignored',
        )
        return reply.code(200).send()
      }

      // Unknown payload shape — ack 200 (so Slack doesn't retry) but
      // log so we notice anything new.
      req.log.warn(
        {
          metric: 'slack.event.unknown',
          body_keys: Object.keys(body),
        },
        'slack payload not recognised by slice 1',
      )
      return reply.code(200).send()
    })
  })

  app.log.info({ url: '/slack/events' }, 'Slack route registered')
}
