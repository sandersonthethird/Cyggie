import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { eq, and, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import { decryptToken } from '../auth/token-crypto'
import type { GatewayEnv } from '../env'

// Detect Google's `invalid_grant` — the one error that means the refresh token
// itself is dead (revoked / expired / password-changed). google-auth-library
// surfaces it on the GaxiosError as response.data.error and in the message.
// Everything else (5xx, ENOTFOUND, rate limit) is transient and must NOT force
// re-consent.
function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const data = (err as { response?: { data?: { error?: unknown } } }).response?.data
  if (data && typeof data === 'object' && 'error' in data && data.error === 'invalid_grant') {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('invalid_grant')
}

// First read endpoint per the mobile V1 plan (M1b). Calendar today + range.
//
// Flow:
//   1. Verify JWT → req.user.sub is the user_id
//   2. Load the user's Google access_token from oauth_tokens
//      - If expired, refresh server-side using refresh_token
//      - If refresh fails with invalid_grant, set needs_reauth=true and return
//        reauth_required to the client
//   3. Call Google Calendar API events.list (forward `pageToken` if provided)
//   4. Return a stable normalized shape (subset of MeetingPlatform / Meeting types)
//      along with `nextPageToken` when Google indicates more pages — mobile's
//      infinite-scroll drains the token chain before advancing the day cursor
//      to prevent silent truncation on dense weeks.

const CalendarEventSchema = z.object({
  id: z.string(),
  calendarEventId: z.string(),
  title: z.string(),
  start: z.string(), // ISO timestamp
  end: z.string(),
  attendees: z.array(z.object({ email: z.string(), displayName: z.string().optional() })),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  isAllDay: z.boolean(),
  /**
   * Server-side meeting status if this calendar event has an associated
   * recording in the meetings table (joined by calendar_event_id). Mobile
   * uses this to render a small pill on the calendar card so the user
   * sees "Transcribing…" / "Failed" / etc. without tapping in.
   * Absent when there's no linked meeting or when the meetings lookup
   * failed (we degrade gracefully — the pill is purely additive UX).
   */
  recordingStatus: z.string().optional(),
  /**
   * Meeting id if this calendar event has an associated meeting row.
   * Used by mobile's tap handler to navigate directly to /meetings/<id>
   * without an extra round-trip through POST /meetings/from-calendar-event.
   * Absent when no meeting exists yet (mobile then auto-creates on tap).
   */
  meetingId: z.string().optional(),
  /**
   * Primary linked company for this event's meeting, when one exists.
   * Mobile renders the company's Clearbit logo on the calendar card so the
   * row reads as "Acme partner check-in" at a glance. We only pick one
   * company even when a meeting has many linked — the calendar card has
   * room for one logo. Absent when there's no meeting yet, no linked
   * company, or the join failed (graceful degradation: card just shows
   * the time/title as before).
   */
  company: z
    .object({
      id: z.string(),
      name: z.string(),
      primaryDomain: z.string().nullable(),
    })
    .optional(),
})

export async function registerCalendarRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'GET',
    url: '/calendar/events',
    schema: {
      querystring: z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(250).default(50),
        // Opaque Google-issued pagination token. Mobile drains the chain
        // before advancing its day cursor — see fetchCalendarPage in
        // mobile/lib/api/calendar.ts. Strict charset rejection prevents
        // arbitrary strings from being proxied through to googleapis.
        pageToken: z
          .string()
          .max(2048)
          .regex(/^[A-Za-z0-9_=-]+$/)
          .optional(),
      }),
      response: {
        200: z.object({
          events: z.array(CalendarEventSchema),
          nextPageToken: z.string().optional(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireUser()
      const db = getDb(env.GATEWAY_DATABASE_URL)

      // Default window: now → +14 days. Mobile "today" view filters client-side.
      const now = new Date()
      const fromDate = req.query.from ? new Date(req.query.from) : now
      const toDate = req.query.to
        ? new Date(req.query.to)
        : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

      const oauth = await db.query.oauthTokens.findFirst({
        where: eq(schema.oauthTokens.userId, user.sub),
      })
      if (!oauth) {
        throw new GatewayError({
          statusCode: 401,
          code: 'NO_GOOGLE_TOKENS',
          message: 'User has no Google OAuth tokens — sign in again',
          reauthRequired: true,
        })
      }
      if (oauth.needsReauth) {
        throw new GatewayError({
          statusCode: 401,
          code: 'REAUTH_REQUIRED',
          message: 'Google access has expired or been revoked',
          reauthRequired: true,
        })
      }
      if (!oauth.accessToken) {
        throw new GatewayError({
          statusCode: 401,
          code: 'NO_ACCESS_TOKEN',
          message: 'No usable Google access token',
          reauthRequired: true,
        })
      }

      // Decrypt the stored refresh token so google-auth-library can mint a fresh
      // access token on its own when the current one is expired. A legacy row
      // (SHA-256 hash from before token-crypto) or a key mismatch throws here →
      // flip needs_reauth and bounce the user through OAuth once, which re-stores
      // a real encrypted refresh token.
      let refreshToken: string
      try {
        refreshToken = decryptToken(oauth.refreshTokenEncrypted ?? '', env.GOOGLE_TOKEN_ENC_KEY)
      } catch (err) {
        await db
          .update(schema.oauthTokens)
          .set({ needsReauth: true, updatedAt: new Date() })
          .where(eq(schema.oauthTokens.id, oauth.id))
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err), userId: user.sub },
          'google refresh token undecryptable — forcing reauth',
        )
        throw new GatewayError({
          statusCode: 401,
          code: 'REAUTH_REQUIRED',
          message: 'Google access has expired or been revoked',
          reauthRequired: true,
        })
      }

      const client = new google.auth.OAuth2({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      })
      // expiry_date is epoch ms (not a Date). With a refresh_token set, the
      // library auto-refreshes when this is past and emits 'tokens'.
      client.setCredentials({
        access_token: oauth.accessToken,
        refresh_token: refreshToken,
        expiry_date: oauth.accessTokenExpiresAt?.getTime() ?? null,
      })

      // Persist the refreshed access token (+ expiry) so the next request reuses
      // it instead of refreshing again. Persist access_token + expiry ONLY —
      // Google omits the refresh token on refresh, so writing it back would null
      // out refresh_token_encrypted and re-break the cycle. The listener is
      // fire-and-forget (EventEmitter doesn't await); a failed write self-heals
      // on the next request, so we just log it with context.
      client.on('tokens', (tokens) => {
        if (!tokens.access_token) return
        void db
          .update(schema.oauthTokens)
          .set({
            accessToken: tokens.access_token,
            accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            lastRefreshedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.oauthTokens.id, oauth.id))
          .catch((err: unknown) => {
            req.log.warn(
              { err: err instanceof Error ? err.message : String(err), userId: user.sub },
              'failed to persist refreshed google access token (will retry next request)',
            )
          })
      })

      const calendar = google.calendar({ version: 'v3', auth: client })
      let response
      try {
        response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: fromDate.toISOString(),
          timeMax: toDate.toISOString(),
          maxResults: req.query.limit,
          singleEvents: true,
          orderBy: 'startTime',
          ...(req.query.pageToken ? { pageToken: req.query.pageToken } : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Only a genuinely dead refresh token (invalid_grant: revoked, expired,
        // or password-changed) warrants forcing re-consent. The library already
        // tried to refresh; if it still failed with invalid_grant the credential
        // is unrecoverable. Anything else (network blip, Google 5xx, rate limit)
        // is transient — surface a retryable error WITHOUT flipping needs_reauth,
        // so a momentary hiccup doesn't kick the user back through OAuth.
        if (isInvalidGrant(err)) {
          await db
            .update(schema.oauthTokens)
            .set({ needsReauth: true, updatedAt: new Date() })
            .where(eq(schema.oauthTokens.id, oauth.id))
          req.log.warn({ err: msg, userId: user.sub }, 'google refresh failed (invalid_grant)')
          throw new GatewayError({
            statusCode: 401,
            code: 'GOOGLE_AUTH_FAILED',
            message: 'Google rejected the calendar request — sign in again',
            reauthRequired: true,
          })
        }
        req.log.warn({ err: msg, userId: user.sub }, 'google calendar list failed (transient)')
        throw new GatewayError({
          statusCode: 502,
          code: 'GOOGLE_UNAVAILABLE',
          message: 'Could not reach Google Calendar — try again',
        })
      }

      const events = (response.data.items ?? []).map((ev) => {
        const start = ev.start?.dateTime ?? ev.start?.date ?? null
        const end = ev.end?.dateTime ?? ev.end?.date ?? null
        return {
          id: ev.id ?? '',
          calendarEventId: ev.id ?? '',
          title: ev.summary ?? '(no title)',
          start: start ?? '',
          end: end ?? '',
          attendees: (ev.attendees ?? [])
            .filter((a) => a.email)
            .map((a) => ({
              email: a.email ?? '',
              ...(a.displayName ? { displayName: a.displayName } : {}),
            })),
          ...(ev.location ? { location: ev.location } : {}),
          ...(ev.hangoutLink ? { meetingUrl: ev.hangoutLink } : {}),
          isAllDay: ev.start?.dateTime == null,
        }
      })

      // Augment with recording status from the meetings table. The pill is
      // purely additive UX — wrap defensively so a Neon hiccup or a future
      // refactor of the meetings table cannot break the calendar list,
      // which is the core feature of this route.
      const calEventIds = events.map((e) => e.calendarEventId).filter((id) => id.length > 0)
      type EventCompany = { id: string; name: string; primaryDomain: string | null }
      if (calEventIds.length > 0) {
        try {
          const recordings = await db
            .select({
              id: schema.meetings.id,
              calendarEventId: schema.meetings.calendarEventId,
              status: schema.meetings.status,
            })
            .from(schema.meetings)
            .where(
              and(
                eq(schema.meetings.userId, user.sub),
                inArray(schema.meetings.calendarEventId, calEventIds),
              ),
            )
          const byCalEventId = new Map<string, { id: string; status: string }>()
          for (const r of recordings) {
            if (r.calendarEventId) byCalEventId.set(r.calendarEventId, { id: r.id, status: r.status })
          }

          // Bulk-fetch one linked company per meeting so the card can render
          // the Clearbit logo. Wrapped in its own try so a failure here can't
          // break the recording-status pill we just attached.
          const companyByMeetingId = new Map<string, EventCompany>()
          const meetingIds = Array.from(byCalEventId.values()).map((m) => m.id)
          if (meetingIds.length > 0) {
            try {
              const links = await db
                .select({
                  meetingId: schema.meetingCompanyLinks.meetingId,
                  confidence: schema.meetingCompanyLinks.confidence,
                  companyId: schema.orgCompanies.id,
                  name: schema.orgCompanies.canonicalName,
                  primaryDomain: schema.orgCompanies.primaryDomain,
                })
                .from(schema.meetingCompanyLinks)
                .innerJoin(
                  schema.orgCompanies,
                  eq(schema.meetingCompanyLinks.companyId, schema.orgCompanies.id),
                )
                .where(inArray(schema.meetingCompanyLinks.meetingId, meetingIds))
              // Pick the highest-confidence link per meeting; ties broken
              // by company id for stable rendering across requests.
              for (const link of links) {
                const existing = companyByMeetingId.get(link.meetingId)
                const candidate: EventCompany = {
                  id: link.companyId,
                  name: link.name,
                  primaryDomain: link.primaryDomain,
                }
                if (!existing) {
                  companyByMeetingId.set(link.meetingId, candidate)
                  continue
                }
                // Need the existing confidence to compare — re-find it.
                // Cheap; this map only has one entry per meeting and we're
                // already iterating a small linked-rows list.
                const existingLink = links.find(
                  (l) => l.meetingId === link.meetingId && l.companyId === existing.id,
                )
                const existingConf = existingLink?.confidence ?? 0
                if (
                  link.confidence > existingConf ||
                  (link.confidence === existingConf && link.companyId < existing.id)
                ) {
                  companyByMeetingId.set(link.meetingId, candidate)
                }
              }
            } catch (err) {
              req.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'meeting_company_links join failed; calendar cards omit logos',
              )
            }
          }

          for (const ev of events) {
            const m = byCalEventId.get(ev.calendarEventId)
            if (m) {
              ;(ev as {
                recordingStatus?: string
                meetingId?: string
                company?: EventCompany
              }).recordingStatus = m.status
              ;(ev as {
                recordingStatus?: string
                meetingId?: string
                company?: EventCompany
              }).meetingId = m.id
              const c = companyByMeetingId.get(m.id)
              if (c) {
                ;(ev as {
                  recordingStatus?: string
                  meetingId?: string
                  company?: EventCompany
                }).company = c
              }
            }
          }
        } catch (err) {
          req.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'meetings join failed; returning calendar events without recordingStatus/meetingId',
          )
        }
      }

      // Surface Google's nextPageToken when present so mobile can drain
      // the chain before advancing its 30-day day cursor. Absent when
      // we're on the last page.
      const nextPageToken = response.data.nextPageToken ?? undefined
      // Observability: when we just returned a page at the limit, log it
      // so we know dense-week truncation drains are firing in prod.
      if (events.length >= req.query.limit) {
        req.log.info(
          { userId: user.sub, count: events.length, hasMore: !!nextPageToken, metric: 'calendar.page_truncated' },
          'calendar page at limit; nextPageToken present? %s',
          !!nextPageToken,
        )
      }
      return nextPageToken ? { events, nextPageToken } : { events }
    },
  })
}

// Suppress unused-import warning for OAuth2Client (we use it via `google.auth.OAuth2`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ImportRef = OAuth2Client
