import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { eq, and, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

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

      const client = new google.auth.OAuth2({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      })
      client.setCredentials({
        access_token: oauth.accessToken,
        expiry_date: oauth.accessTokenExpiresAt?.getTime() ?? null,
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
        // Token expired during a stretch of inactivity → flip needs_reauth and bail.
        // Google's invalid_grant on access_token usually means refresh is fine, but
        // V1 keeps it simple — push the user back through OAuth.
        await db
          .update(schema.oauthTokens)
          .set({ needsReauth: true, updatedAt: new Date() })
          .where(eq(schema.oauthTokens.id, oauth.id))
        const msg = err instanceof Error ? err.message : String(err)
        req.log.warn({ err: msg }, 'google calendar list failed')
        throw new GatewayError({
          statusCode: 401,
          code: 'GOOGLE_AUTH_FAILED',
          message: 'Google rejected the calendar request — sign in again',
          reauthRequired: true,
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
          for (const ev of events) {
            const m = byCalEventId.get(ev.calendarEventId)
            if (m) {
              ;(ev as { recordingStatus?: string; meetingId?: string }).recordingStatus = m.status
              ;(ev as { recordingStatus?: string; meetingId?: string }).meetingId = m.id
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
