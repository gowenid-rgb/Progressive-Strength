-- 002 — Persistent exercise substitutions (T3-9).
--
-- The first DATA-PRESERVING migration. 001 could drop a table because the free window was
-- open and the only user had agreed to a purge. That window is closed: from here migrations
-- carry real training history forward, and this file only adds.
--
-- Decision D6: a swap is either "this session only" or "this and future". The session-only
-- case needs nothing stored beyond workout_sets.swapped_from, which already exists. The
-- persistent case has to outlive the current week — a week generated next Monday knows
-- nothing about a swap made today unless the preference is recorded and fed back into the
-- prompt. Hence a cycle-level list rather than an edit to the current week's plan.

ALTER TABLE cycles
    ADD COLUMN IF NOT EXISTS substitutions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN cycles.substitutions IS
    'T3-9: [{from, to, createdAt}] — movements the user has permanently swapped for this cycle. Injected into plan generation prompts so future weeks honour the substitution.';
