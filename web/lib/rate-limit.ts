import { getDb } from './db'
import { rateLimits, memoRateLimits, noteRateLimits } from '../drizzle/schema'
import { sql } from 'drizzle-orm'

const DAILY_LIMIT = 50

type RateLimitTable = typeof rateLimits | typeof memoRateLimits | typeof noteRateLimits

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runRateLimitCheck(token: string, table: any): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().split('T')[0]

  const result = await getDb()
    .insert(table)
    .values({
      token,
      chatCountDay: 1,
      lastReset: today,
      totalQueries: 1,
    })
    .onConflictDoUpdate({
      target: table.token,
      set: {
        chatCountDay: sql`CASE
          WHEN ${table.lastReset} < ${today} THEN 1
          ELSE ${table.chatCountDay} + 1
        END`,
        lastReset: sql`CASE
          WHEN ${table.lastReset} < ${today} THEN ${today}::date
          ELSE ${table.lastReset}
        END`,
        totalQueries: sql`${table.totalQueries} + 1`,
      },
    })
    .returning({ chatCountDay: table.chatCountDay })

  const count = result[0]?.chatCountDay ?? 0
  return { allowed: count <= DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - count) }
}

export async function checkRateLimit(token: string): Promise<{ allowed: boolean; remaining: number }> {
  return runRateLimitCheck(token, rateLimits as RateLimitTable)
}

export async function checkMemoRateLimit(token: string): Promise<{ allowed: boolean; remaining: number }> {
  return runRateLimitCheck(token, memoRateLimits as RateLimitTable)
}

export async function checkNoteRateLimit(token: string): Promise<{ allowed: boolean; remaining: number }> {
  return runRateLimitCheck(token, noteRateLimits as RateLimitTable)
}
