-- 001 — Phase 2 schema.
--
-- Replaces the two-JSONB-blob `user_data` model with real tables.
--
-- DESTRUCTIVE: drops user_data and every plan and workout in it. Agreed 2026-09-12
-- (decision D10) on the basis that the only user was the developer, who intended to
-- rebuild as a 6-week cycle regardless. Do not re-run this reasoning on a later
-- migration — from 002 onward there is real data and migrations must preserve it.

-- users predates this migration on the deployed database but will not exist on a fresh
-- one (a local dev database, or the test suite). IF NOT EXISTS makes 001 correct in both
-- cases: adopt the existing table, or create it.
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS user_data;

-- A training cycle: N weeks working toward one goal.
CREATE TABLE IF NOT EXISTS cycles (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT,
    goal              TEXT,
    experience_level  TEXT,
    equipment         TEXT,
    training_days     INTEGER,
    extra_details     TEXT,
    total_weeks       INTEGER NOT NULL DEFAULT 1,
    current_week      INTEGER NOT NULL DEFAULT 1,
    status            TEXT    NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

-- A user may have many cycles over time but only one in progress. Enforced in the
-- database rather than in application code, because "somehow ended up with two active
-- cycles" is the kind of state that is miserable to debug after the fact.
CREATE UNIQUE INDEX IF NOT EXISTS cycles_one_active_per_user
    ON cycles (user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS cycles_user_created ON cycles (user_id, created_at DESC);

-- One generated plan per week (decision D3). Kept after completion (decision D4), so
-- an adjustment can rewrite an upcoming week without touching finished ones, and so
-- long-term review can look back across cycles.
CREATE TABLE IF NOT EXISTS week_plans (
    id           SERIAL PRIMARY KEY,
    cycle_id     INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    week_number  INTEGER NOT NULL,
    phase        TEXT,
    plan         JSONB   NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'upcoming',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, week_number)
);

-- One completed session. Append-only: finishing a workout inserts a row, it is never
-- rewritten. This is what fixes the last-write-wins blob sync (T3-3) for history.
CREATE TABLE IF NOT EXISTS workouts (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cycle_id         INTEGER REFERENCES cycles(id) ON DELETE SET NULL,
    week_number      INTEGER,
    day_index        INTEGER,
    day_name         TEXT,
    plan_name        TEXT,
    notes            TEXT,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS workouts_user_finished ON workouts (user_id, finished_at DESC);

-- The row that makes metrics (T3-10) and long-term AI review (T3-12) possible at all.
--
-- weight_value/reps_value are parsed for querying. weight_raw/reps_raw preserve exactly
-- what the user typed and are never derived from. A parser bug must not be able to
-- rewrite someone's training history — the normalised columns are a convenience, the
-- raw columns are the record.
CREATE TABLE IF NOT EXISTS workout_sets (
    id             SERIAL PRIMARY KEY,
    workout_id     INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_name  TEXT    NOT NULL,
    exercise_order INTEGER NOT NULL DEFAULT 0,
    set_number     INTEGER NOT NULL,
    weight_value   NUMERIC,
    weight_unit    TEXT,
    is_bodyweight  BOOLEAN NOT NULL DEFAULT false,
    reps_value     INTEGER,
    weight_raw     TEXT,
    reps_raw       TEXT,
    -- T3-9: when a movement was substituted, what it replaced. Without this the AI sees
    -- someone who silently stopped doing pull-ups, with no idea it was an equipment
    -- constraint rather than a programming choice.
    swapped_from   TEXT,
    logged_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workout_sets_workout  ON workout_sets (workout_id);
CREATE INDEX IF NOT EXISTS workout_sets_exercise ON workout_sets (exercise_name);

-- Check-in reflections. Previously localStorage-only and lost on any new device (T3-2),
-- despite the plan generator being built to read them.
CREATE TABLE IF NOT EXISTS journal_entries (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cycle_id    INTEGER REFERENCES cycles(id) ON DELETE SET NULL,
    week_number INTEGER,
    energy      TEXT,
    intentions  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journal_entries_user ON journal_entries (user_id, created_at DESC);
