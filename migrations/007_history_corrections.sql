-- 007 — Correcting logged history, and never logging a session twice.
--
-- History has been append-only since T3-3, which protected it from the sync bugs that once wiped
-- it, but left no way to fix a set that was mis-logged. This keeps the protection and adds the
-- fix, as CORRECTIONS rather than rewrites:
--
--   * deleting a set or a session is soft: the row stays, marked deleted_at
--   * an edit keeps the old values in workout_edits
--
-- so nothing the lifter logged is destroyed by correcting it, and any correction can be undone
-- by hand. Every query that reads history now ignores soft-deleted rows.
--
-- It also adds a client-supplied id to each workout. The same session posted twice (a double
-- tap, a retry, or the "restore workouts this device holds" routine re-uploading) now returns
-- the original instead of creating a second copy.
--
-- Data-preserving: only adds columns, a table and an index. Existing rows are backfilled.

ALTER TABLE workouts
    ADD COLUMN IF NOT EXISTS client_id  TEXT,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE workout_sets
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;

-- Give every existing workout an id of the form the app derives for sessions saved before this
-- existed: 'legacy:' + the ISO timestamp the client sent as `date`. That is what lets a device
-- re-uploading an old session be recognised as a repeat.
--
-- Two existing sessions can share a timestamp to the millisecond (exactly what a duplicated
-- upload produces). They are NOT merged or removed: the second keeps its row and gets a '#id'
-- suffix so the unique index below can be created, and the lifter can review it in their history.
WITH numbered AS (
    SELECT id,
           'legacy:' || to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS base,
           row_number() OVER (PARTITION BY user_id, finished_at ORDER BY id) AS n
      FROM workouts
     WHERE client_id IS NULL
)
UPDATE workouts w
   SET client_id = CASE WHEN numbered.n = 1 THEN numbered.base ELSE numbered.base || '#' || w.id END
  FROM numbered
 WHERE w.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS workouts_client_id
    ON workouts (user_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workout_edits (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workout_id INTEGER REFERENCES workouts(id) ON DELETE CASCADE,
    set_id     INTEGER REFERENCES workout_sets(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    before     JSONB,
    after      JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workout_edits_workout ON workout_edits (workout_id, created_at DESC);

COMMENT ON TABLE workout_edits IS
    'Audit trail for corrections to logged history: what a set or session looked like before it was edited, moved, renamed or deleted.';
