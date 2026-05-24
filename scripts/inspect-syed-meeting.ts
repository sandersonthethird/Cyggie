// Diagnostic: find the Syed meeting + show its sync-relevant state on Neon.
import pg from 'pg'

const { Pool } = pg

if (!process.env['GATEWAY_DATABASE_URL']) {
  throw new Error('GATEWAY_DATABASE_URL required')
}

const pool = new Pool({ connectionString: process.env['GATEWAY_DATABASE_URL'], max: 2 })

async function main() {
  const client = await pool.connect()
  try {
    // 1. Find any meeting with "syed" in the title (case-insensitive), plus
    //    any meeting on 5/22/2026 in the 13:00-15:30 window regardless of title.
    const rows = await client.query<{
      id: string
      user_id: string
      title: string | null
      status: string
      lamport: string
      date: Date | null
      created_at: Date
      updated_at: Date
      transcript_present: boolean
      transcript_segment_count: number | null
      summary_present: boolean
      deepgram_request_id: string | null
    }>(`
      SELECT
        id,
        user_id,
        title,
        status,
        lamport,
        date,
        created_at,
        updated_at,
        (transcript_segments IS NOT NULL
          AND jsonb_typeof(transcript_segments) = 'array'
          AND jsonb_array_length(transcript_segments) > 0) AS transcript_present,
        CASE
          WHEN jsonb_typeof(transcript_segments) = 'array'
            THEN jsonb_array_length(transcript_segments)
          ELSE NULL
        END AS transcript_segment_count,
        (summary IS NOT NULL AND length(summary) > 0) AS summary_present,
        deepgram_request_id
      FROM meetings
      WHERE title ILIKE '%syed%'
         OR (
           date BETWEEN '2026-05-22 13:00:00Z' AND '2026-05-22 15:30:00Z'
         )
         OR (
           created_at BETWEEN '2026-05-22 13:00:00Z' AND '2026-05-22 15:30:00Z'
         )
      ORDER BY COALESCE(date, created_at) DESC
      LIMIT 25
    `)

    console.log(`[inspect] matches: ${rows.rowCount}`)
    for (const r of rows.rows) {
      console.log('-----')
      console.log(`id:                       ${r.id}`)
      console.log(`title:                    ${r.title}`)
      console.log(`status:                   ${r.status}`)
      console.log(`lamport:                  ${r.lamport}`)
      console.log(`date:                     ${r.date?.toISOString() ?? '<null>'}`)
      console.log(`created_at:               ${r.created_at.toISOString()}`)
      console.log(`updated_at:               ${r.updated_at.toISOString()}`)
      console.log(`transcript_present:       ${r.transcript_present}`)
      console.log(`transcript_segment_count: ${r.transcript_segment_count}`)
      console.log(`summary_present:          ${r.summary_present}`)
      console.log(`deepgram_request_id:      ${r.deepgram_request_id ?? '<null>'}`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[inspect] FAILED:', err)
  process.exit(1)
})
