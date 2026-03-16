import type Database from 'better-sqlite3'

export function runBuiltinFieldDefsMigration(db: Database.Database): void {
  // Add is_builtin column if it doesn't exist yet
  const tableInfo = db.prepare(`PRAGMA table_info(custom_field_definitions)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))
  if (!existingColumns.has('is_builtin')) {
    db.exec(`ALTER TABLE custom_field_definitions ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;`)
  }

  // Seed built-in select fields — INSERT OR IGNORE is idempotent
  db.exec(`
    INSERT OR IGNORE INTO custom_field_definitions
      (id, entity_type, field_key, label, field_type, options_json, is_builtin,
       is_required, sort_order, show_in_list, created_at, updated_at)
    VALUES
      ('builtin:entityType',         'company', 'entityType',        'Type',            'select', NULL, 1, 0, -100, 0, datetime('now'), datetime('now')),
      ('builtin:pipelineStage',      'company', 'pipelineStage',     'Stage',           'select', NULL, 1, 0,  -99, 0, datetime('now'), datetime('now')),
      ('builtin:priority',           'company', 'priority',          'Priority',        'select', NULL, 1, 0,  -98, 0, datetime('now'), datetime('now')),
      ('builtin:round',              'company', 'round',             'Round',           'select', NULL, 1, 0,  -97, 0, datetime('now'), datetime('now')),
      ('builtin:targetCustomer',     'company', 'targetCustomer',    'Target Customer', 'select', NULL, 1, 0,  -96, 0, datetime('now'), datetime('now')),
      ('builtin:businessModel',      'company', 'businessModel',     'Business Model',  'select', NULL, 1, 0,  -95, 0, datetime('now'), datetime('now')),
      ('builtin:productStage',       'company', 'productStage',      'Product Stage',   'select', NULL, 1, 0,  -94, 0, datetime('now'), datetime('now')),
      ('builtin:employeeCountRange', 'company', 'employeeCountRange','Employees',       'select', NULL, 1, 0,  -93, 0, datetime('now'), datetime('now')),
      ('builtin:contactType',        'contact', 'contactType',       'Contact Type',    'select', NULL, 1, 0, -100, 0, datetime('now'), datetime('now'));
  `)
}
