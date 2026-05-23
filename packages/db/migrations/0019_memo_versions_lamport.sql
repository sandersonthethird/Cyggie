-- Memo sync — add lamport to investment_memo_versions so it can join the
-- sync engine alongside investment_memos (which already has lamport from
-- migration 017's drizzle schema).
--
-- investment_memo_versions is append-only by design (UNIQUE(memo_id,
-- version_number) gives natural dedup), so per-row lamport isn't strictly
-- needed for conflict resolution — but the sync protocol requires every
-- owned-table row to carry a lamport so the gateway's /sync/push handler
-- can run its uniform "SELECT lamport WHERE PK" lookup. Default '0' is
-- fine since INSERTs are the only op.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (Postgres 9.6+).

ALTER TABLE "investment_memo_versions"
  ADD COLUMN IF NOT EXISTS "lamport" text NOT NULL DEFAULT '0';
