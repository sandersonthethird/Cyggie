-- target_investment fields — investment-thesis fit captured on the company
-- Overview panel. Mirrors the desktop org_companies columns added in SQLite
-- migration 114 so the Phase 1.5a sync (whole-row org_companies projection)
-- can carry them to Neon. See packages/db/src/schema/companies.ts.
--
-- target_investment_stage: single-select stage value (e.g. 'seed').
-- target_investment_sector: multi-select sector, stored CSV (e.g. 'FinTech,SaaS').
--
-- Additive + idempotent (IF NOT EXISTS) so db:push convergence is safe and the
-- drizzle journal stays re-baselined at 0031 (see commit 46c6dc3).
ALTER TABLE org_companies ADD COLUMN IF NOT EXISTS target_investment_stage text;
ALTER TABLE org_companies ADD COLUMN IF NOT EXISTS target_investment_sector text;
