-- Phase 4 RLS — owner-aware row visibility for cyggie_execute_sql.
--
-- ⚠ CORRECTNESS PRECONDITIONS (verify before applying to prod):
--   1. The gateway's main role (GATEWAY_DATABASE_URL) MUST be the OWNER of
--      contacts/meetings (or hold BYPASSRLS). Table owners bypass RLS unless
--      FORCE ROW LEVEL SECURITY is set (it is NOT here), so normal sync/REST
--      reads stay unaffected. On Neon the role that ran these migrations owns
--      the tables and is the same role the gateway connects with — so this
--      holds. If you ever split the gateway onto a non-owner role, it would
--      start getting RLS-filtered (empty reads when app.user_id is unset).
--   2. The read-only role `cyggie_readonly` (NEON_READONLY_URL, used only by
--      cyggie_execute_sql) MUST NOT have BYPASSRLS — otherwise the policy is
--      a no-op for it. It is a plain LOGIN role with SELECT grants only
--      (see api-gateway/src/db/readonly-pool.ts ROLE_GRANT_SCRIPT), so it is
--      subject to RLS. cyggie_execute_sql SET LOCALs app.user_id/app.firm_id
--      per query to drive the policy.
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "contacts_readonly_visibility" ON "contacts" AS PERMISSIVE FOR SELECT TO public USING (user_id = current_setting('app.user_id', true) OR (firm_id = current_setting('app.firm_id', true) AND is_private = false));--> statement-breakpoint
CREATE POLICY "meetings_readonly_visibility" ON "meetings" AS PERMISSIVE FOR SELECT TO public USING (user_id = current_setting('app.user_id', true) OR (firm_id = current_setting('app.firm_id', true) AND is_private = false));