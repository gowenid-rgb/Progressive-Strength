-- 004 — The programme (Phase 3).
--
-- A cycle now carries its design, not just its length: the split, the movements, the
-- progression rule, and what each week is for. Weeks are rendered from it rather than
-- generated independently.
--
-- Data-preserving. Cycles created before this have no programme and are left alone — they
-- finish under the old week-at-a-time behaviour rather than being retrofitted with a design
-- that was never actually followed.

ALTER TABLE cycles
    ADD COLUMN IF NOT EXISTS program JSONB;

COMMENT ON COLUMN cycles.program IS
    'Phase 3: the cycle design — days/movements (fixed for the cycle), progression rule, and a per-week arc. Weeks are rendered from this. NULL for cycles created before 004.';
