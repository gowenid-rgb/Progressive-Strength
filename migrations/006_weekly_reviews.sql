-- 006 — The weekly coach review.
--
-- One review per user per cycle week, generated on request and kept. Storing it means
-- reopening the Journal costs nothing and a review the lifter already read does not change
-- under them; asking again overwrites it (the unique key makes that an upsert).
--
-- `sessions` records how many workouts the review was based on, so the app can tell the
-- lifter when it is out of date ("2 new sessions since") instead of silently showing advice
-- about a week that has moved on.
--
-- Data-preserving: a new table, nothing existing is touched.

CREATE TABLE IF NOT EXISTS weekly_reviews (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cycle_id     INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    week_number  INTEGER NOT NULL,
    review       JSONB   NOT NULL,
    sessions     INTEGER NOT NULL DEFAULT 0,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, week_number)
);

CREATE INDEX IF NOT EXISTS weekly_reviews_user ON weekly_reviews (user_id, generated_at DESC);

COMMENT ON TABLE weekly_reviews IS
    'The AI coach''s review of one cycle week: what happened, what to watch, what to focus on next.';
