import type Database from 'better-sqlite3'

/**
 * Rewrites the 5 default meeting-summary template rows seeded by
 * seedDefaultTemplates() to use `Attendees: {{attendees}}` in the prompt
 * header instead of `Participants: {{speakers}}`.
 *
 * Why a migration instead of editing DEFAULT_TEMPLATES alone: seeding
 * only runs once (early-return when any is_default=1 row exists), so
 * existing users would otherwise keep the stale header line that drove
 * the LLM to hallucinate attendees from transcript-mentioned names. The
 * companion change in @cyggie/services/llm/templates.ts populates the
 * {{attendees}} placeholder with calendar-truth (selfName + attendees),
 * but only if the template string references {{attendees}} — hence this
 * row-level rewrite.
 *
 * Customization safety: the LIKE guard skips any row where a user has
 * edited the template such that the original "Participants: {{speakers}}"
 * header is no longer present. Default templates ARE user-editable via
 * updateTemplate (template.repo.ts:87+); we don't want to clobber their
 * tweaks.
 *
 * Idempotent — after the migration runs, target rows contain
 * "Attendees: {{attendees}}" and the LIKE filter no longer matches them
 * (re-runs are no-ops).
 */
export function runDefaultTemplatesAttendeesPlaceholderMigration(
  db: Database.Database,
): void {
  // Skip cleanly if templates table doesn't exist yet (first-launch
  // ordering — seeding runs after migrations).
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='templates'`,
    )
    .get()
  if (!tableExists) return

  db.prepare(
    `UPDATE templates
       SET user_prompt_template = REPLACE(
             user_prompt_template,
             'Participants: {{speakers}}',
             'Attendees: {{attendees}}'
           ),
           updated_at = datetime('now')
     WHERE is_default = 1
       AND user_prompt_template LIKE '%Participants: {{speakers}}%'`,
  ).run()
}
