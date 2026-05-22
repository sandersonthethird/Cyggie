-- T24 — per-user AI provider credentials.
--
-- Why a NEW table instead of reusing `settings`: the `settings` schema's
-- inline security note explicitly excludes API credentials. Keeping them
-- in their own table makes the access boundary unambiguous and lets us
-- later add pgcrypto without touching the user-prefs path.
--
-- Single-firm-beta posture: TLS in transit + Neon at-rest encryption only.
-- No pgcrypto / no app-level encryption. Promote to encrypted-at-row when
-- multi-tenant onboarding lands (T24 follow-up; add ALTER + re-encrypt).
--
-- Provider whitelist enforced by a CHECK constraint so a typo doesn't
-- silently introduce a phantom provider name. Extend via ALTER ... ADD
-- CONSTRAINT when adding OpenAI/Ollama gateway-side support.
--
-- IF NOT EXISTS for safe re-runs against the single Neon branch (same
-- pattern as 0015). Plain CREATE TABLE is non-blocking; safe to apply
-- live.

CREATE TABLE IF NOT EXISTS "user_credentials" (
  "user_id"    text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider"   text NOT NULL,
  "value"      text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "provider"),
  CONSTRAINT "user_credentials_provider_check"
    CHECK ("provider" IN ('anthropic', 'openai', 'deepgram'))
);
