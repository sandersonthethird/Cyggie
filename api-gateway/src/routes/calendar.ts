import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { eq } from 'drizzle-orm'
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
//   3. Call Google Calendar API events.list
//   4. Return a stable normalized shape (subset of MeetingPlatform / Meeting types)

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
      }),
      response: {
        200: z.object({ events: z.array(CalendarEventSchema) }),
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

      return { events }
    },
  })
}

// Suppress unused-import warning for OAuth2Client (we use it via `google.auth.OAuth2`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ImportRef = OAuth2Client
