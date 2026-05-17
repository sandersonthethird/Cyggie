import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Custom fields. Consolidates migrations 039 (definitions), 040 (values),
// 046 (builtin defs — seed via repair script), 049 (section column).
//
// Entity types: 'company' | 'contact'. Field types: text, textarea, number,
// currency, date, url, select, multiselect, boolean, contact_ref, company_ref.
//
// CHECK constraints replace SQLite CHECK(entity_type IN (...)) inline checks.

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 16 }).notNull(),
    fieldKey: varchar('field_key', { length: 64 }).notNull(),
    label: text('label').notNull(),
    fieldType: varchar('field_type', { length: 32 }).notNull(),
    optionsJson: jsonb('options_json'),
    isRequired: integer('is_required').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    showInList: integer('show_in_list').notNull().default(0),
    isBuiltin: integer('is_builtin').notNull().default(0),
    section: text('section'),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cfd_entity_field_key_idx').on(t.entityType, t.fieldKey),
    index('cfd_entity_type_idx').on(t.entityType, t.sortOrder),
    check('cfd_entity_type_check', sql`${t.entityType} IN ('company', 'contact')`),
    check(
      'cfd_field_type_check',
      sql`${t.fieldType} IN ('text', 'textarea', 'number', 'currency', 'date', 'url', 'select', 'multiselect', 'boolean', 'contact_ref', 'company_ref')`,
    ),
  ],
)

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 16 }).notNull(),
    entityId: text('entity_id').notNull(),
    valueText: text('value_text'),
    valueNumber: doublePrecision('value_number'),
    valueBoolean: boolean('value_boolean'),
    valueDate: timestamp('value_date', { withTimezone: true }),
    valueRefId: text('value_ref_id'),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cfv_definition_entity_idx').on(t.fieldDefinitionId, t.entityId),
    index('cfv_entity_idx').on(t.entityType, t.entityId),
    check('cfv_entity_type_check', sql`${t.entityType} IN ('company', 'contact')`),
  ],
)
