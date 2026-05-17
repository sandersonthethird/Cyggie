import {
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Audit log — extends desktop's audit.repo.ts pattern. Records sensitive operations
// per plan-ceo-review Section 3 (OAuth events, recording start/stop, mass-export,
// settings changes, credential reads from packages/services CredentialsClient).
//
// Forensic value: if a key is suspected leaked, this log answers "which service
// requested the credential, when, on whose behalf."
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: varchar('device_id', { length: 64 }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    // Examples: 'oauth.signin', 'oauth.refresh', 'oauth.reauth_required',
    //           'recording.start', 'recording.stop', 'recording.finalize_stage1',
    //           'recording.finalize_stage2', 'recording.gap_recovered',
    //           'credential.read', 'export.mass', 'settings.update',
    //           'quota.soft_warn', 'quota.hard_cut'
    actor: varchar('actor', { length: 64 }), // 'user' | 'system' | service-name
    targetKind: varchar('target_kind', { length: 64 }), // 'meeting', 'company', 'credential', etc.
    targetId: text('target_id'),
    details: jsonb('details').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_user_idx').on(t.userId),
    index('audit_event_idx').on(t.eventType),
    index('audit_created_idx').on(t.createdAt),
    index('audit_target_idx').on(t.targetKind, t.targetId),
  ],
)
