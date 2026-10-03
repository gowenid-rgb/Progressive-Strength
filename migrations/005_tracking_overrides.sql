-- 005 — Which movements are judged on progress.
--
-- A warm-up that is done identically every week is not "stalling", and a scorecard that says
-- so teaches the lifter to ignore it. The programme assigns each movement a role (and so a
-- default tracking mode); this column holds the lifter's own corrections for the cycle, keyed
-- by canonical movement name: { "cat cow quadruped rockback": "consistency" }.
--
-- Data-preserving and nullable. Existing cycles simply have no overrides.

ALTER TABLE cycles
    ADD COLUMN IF NOT EXISTS tracking_overrides JSONB;

COMMENT ON COLUMN cycles.tracking_overrides IS
    'Per-cycle corrections to how a movement is tracked: canonical name -> progress | consistency. NULL when there are none.';
