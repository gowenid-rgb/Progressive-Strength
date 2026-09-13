// Data access for the Phase 2 schema.
//
// Everything that touches cycles, plans, workouts and journal entries goes through here,
// so the shape of the database is not spread across route handlers.
//
// The important behavioural change from the old model: workouts are APPEND-ONLY. Finishing
// a session inserts rows; nothing rewrites history. The previous design sent the entire
// journal blob on every save, so any stale client could overwrite everything (T3-3), and
// did (T1-1).
const db = require('./db');
const { parseWeight, parseReps } = require('./units');

/* ------------------------------------------------------------------ cycles */

async function getActiveCycle(userId) {
    const r = await db.query(
        `SELECT * FROM cycles WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    return r.rows[0] || null;
}

// Only one cycle may be active per user (enforced by a partial unique index), so retiring
// the previous one and creating the new one must happen together or not at all.
async function startCycle(userId, opts = {}) {
    return db.withTransaction(async client => {
        await client.query(
            `UPDATE cycles SET status = 'abandoned', completed_at = now()
             WHERE user_id = $1 AND status = 'active'`,
            [userId]
        );
        const r = await client.query(
            `INSERT INTO cycles
                (user_id, name, goal, experience_level, equipment, training_days,
                 extra_details, total_weeks, current_week, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'active')
             RETURNING *`,
            [
                userId,
                opts.name || null,
                opts.goal || null,
                opts.experienceLevel || null,
                opts.equipment || null,
                opts.trainingDays || null,
                opts.extraDetails || null,
                opts.totalWeeks || 1
            ]
        );
        return r.rows[0];
    });
}

async function advanceCycleWeek(cycleId) {
    // LEAST guards against advancing past the end of the cycle if two clients race.
    const r = await db.query(
        `UPDATE cycles
            SET current_week = LEAST(current_week + 1, total_weeks)
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [cycleId]
    );
    return r.rows[0] || null;
}

/**
 * Records a permanent substitution on the active cycle (T3-9, decision D6).
 *
 * Replaces any existing entry for the same `from` movement rather than appending, so swapping
 * A->B and later A->C leaves one rule, not two contradictory ones. Also collapses chains:
 * if the user previously swapped A->B and now swaps B->C, the A rule is retargeted to C so
 * the prompt never carries a stale intermediate.
 */
async function addSubstitution(cycleId, from, to) {
    return db.withTransaction(async client => {
        const r = await client.query('SELECT substitutions FROM cycles WHERE id = $1 FOR UPDATE', [cycleId]);
        if (r.rows.length === 0) return null;

        const list = Array.isArray(r.rows[0].substitutions) ? r.rows[0].substitutions : [];
        const same = a => String(a || '').trim().toLowerCase();

        const next = list
            .filter(x => same(x.from) !== same(from))
            .map(x => (same(x.to) === same(from) ? Object.assign({}, x, { to }) : x));

        next.push({ from, to, createdAt: new Date().toISOString() });

        const saved = await client.query(
            'UPDATE cycles SET substitutions = $2 WHERE id = $1 RETURNING substitutions',
            [cycleId, JSON.stringify(next)]
        );
        return saved.rows[0].substitutions;
    });
}

async function getSubstitutions(cycleId) {
    const r = await db.query('SELECT substitutions FROM cycles WHERE id = $1', [cycleId]);
    if (r.rows.length === 0) return [];
    return Array.isArray(r.rows[0].substitutions) ? r.rows[0].substitutions : [];
}

async function endActiveCycle(userId, status = 'abandoned') {
    const r = await db.query(
        `UPDATE cycles SET status = $2, completed_at = now()
         WHERE user_id = $1 AND status = 'active' RETURNING id`,
        [userId, status]
    );
    return r.rowCount;
}

/* -------------------------------------------------------------- week plans */

async function saveWeekPlan(cycleId, weekNumber, plan, opts = {}) {
    const r = await db.query(
        `INSERT INTO week_plans (cycle_id, week_number, phase, plan, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cycle_id, week_number) DO UPDATE
            SET plan = EXCLUDED.plan,
                phase = EXCLUDED.phase,
                status = EXCLUDED.status,
                generated_at = now()
         RETURNING *`,
        [cycleId, weekNumber, opts.phase || null, JSON.stringify(plan), opts.status || 'active']
    );
    return r.rows[0];
}

async function getWeekPlan(cycleId, weekNumber) {
    const r = await db.query(
        'SELECT * FROM week_plans WHERE cycle_id = $1 AND week_number = $2',
        [cycleId, weekNumber]
    );
    return r.rows[0] || null;
}

/* ---------------------------------------------------------------- workouts */

/**
 * Appends one completed session and its sets.
 *
 * `exercises` is the shape the client already builds in finishWorkout():
 *   [{ name, sets: [{ set, weight, reps, swappedFrom? }] }]
 *
 * Weight and reps arrive as free text and are stored both parsed and raw — see units.js.
 * The whole insert is one transaction, so a session can never land without its sets.
 */
async function appendWorkout(userId, workout) {
    const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];

    return db.withTransaction(async client => {
        const w = await client.query(
            `INSERT INTO workouts
                (user_id, cycle_id, week_number, day_index, day_name, plan_name,
                 notes, started_at, finished_at, duration_seconds)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now()),$10)
             RETURNING *`,
            [
                userId,
                workout.cycleId || null,
                workout.weekNumber || null,
                workout.dayIndex === undefined ? null : workout.dayIndex,
                workout.dayName || null,
                workout.planName || null,
                workout.notes || null,
                workout.startedAt || null,
                workout.date || null,
                workout.durationSeconds || null
            ]
        );
        const saved = w.rows[0];

        for (let i = 0; i < exercises.length; i++) {
            const ex = exercises[i];
            if (!ex || !ex.name) continue;
            const sets = Array.isArray(ex.sets) ? ex.sets : [];

            for (let j = 0; j < sets.length; j++) {
                const s = sets[j] || {};
                const weight = parseWeight(s.weight);
                const reps = parseReps(s.reps);

                await client.query(
                    `INSERT INTO workout_sets
                        (workout_id, exercise_name, exercise_order, set_number,
                         weight_value, weight_unit, is_bodyweight, reps_value,
                         weight_raw, reps_raw, swapped_from)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                    [
                        saved.id,
                        ex.name,
                        i,
                        Number(s.set) || j + 1,
                        weight.value,
                        weight.unit,
                        weight.isBodyweight,
                        reps.value,
                        weight.raw,
                        reps.raw,
                        s.swappedFrom || ex.swappedFrom || null
                    ]
                );
            }
        }

        return saved;
    });
}

/**
 * Recent workouts in the journal shape the client and the AI prompts already expect:
 *   [{ date, planName, dayName, durationSeconds, exercises: [{ name, sets: [...] }] }]
 *
 * Two queries rather than one join, then grouped in JS. At this scale the difference is
 * irrelevant and the grouping stays legible.
 */
async function getWorkoutHistory(userId, limit = 50) {
    const ws = await db.query(
        // id breaks ties: two sessions logged in the same instant share a finished_at, and
        // without a deterministic tiebreak their order — and the "Prev" lookup that walks
        // this array — becomes arbitrary.
        `SELECT * FROM workouts WHERE user_id = $1 ORDER BY finished_at DESC, id DESC LIMIT $2`,
        [userId, limit]
    );
    if (ws.rows.length === 0) return [];

    const ids = ws.rows.map(r => r.id);
    const ss = await db.query(
        `SELECT * FROM workout_sets WHERE workout_id = ANY($1::int[])
         ORDER BY workout_id, exercise_order, set_number`,
        [ids]
    );

    const byWorkout = new Map(ids.map(id => [id, new Map()]));
    for (const s of ss.rows) {
        const exercises = byWorkout.get(s.workout_id);
        if (!exercises.has(s.exercise_name)) {
            exercises.set(s.exercise_name, { name: s.exercise_name, swappedFrom: s.swapped_from || undefined, sets: [] });
        }
        exercises.get(s.exercise_name).sets.push({
            set: s.set_number,
            // Raw is what the user typed; that is what the UI should echo back to them.
            weight: s.weight_raw,
            reps: s.reps_raw,
            weightValue: s.weight_value === null ? null : Number(s.weight_value),
            weightUnit: s.weight_unit,
            isBodyweight: s.is_bodyweight,
            repsValue: s.reps_value
        });
    }

    // Oldest first: the client's "Prev" lookup walks the array backwards expecting that.
    return ws.rows.reverse().map(w => ({
        id: w.id,
        date: w.finished_at,
        planName: w.plan_name,
        dayName: w.day_name,
        weekNumber: w.week_number,
        durationSeconds: w.duration_seconds,
        exercises: Array.from(byWorkout.get(w.id).values())
    }));
}

/* ----------------------------------------------------------------- metrics */

/**
 * Every logged set joined to its session, for the aggregate layer.
 *
 * One flat query rather than per-period aggregates in SQL. At this scale — a year of hard
 * training is a few thousand rows — the difference is immaterial, and it keeps the maths in
 * a pure JS function that can be tested exhaustively without a database.
 */
async function getSetsForMetrics(userId) {
    const r = await db.query(
        `SELECT w.id AS workout_id, w.finished_at, w.cycle_id, w.week_number,
                s.exercise_name, s.weight_value, s.weight_unit, s.is_bodyweight,
                s.reps_value, s.swapped_from
           FROM workouts w
           JOIN workout_sets s ON s.workout_id = w.id
          WHERE w.user_id = $1
          ORDER BY w.finished_at ASC, w.id ASC, s.exercise_order ASC, s.set_number ASC`,
        [userId]
    );
    return r.rows;
}

/* ---------------------------------------------------------- journal entries */

async function appendJournalEntry(userId, entry) {
    const r = await db.query(
        `INSERT INTO journal_entries (user_id, cycle_id, week_number, note)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [userId, entry.cycleId || null, entry.weekNumber || null, entry.note || null]
    );
    return r.rows[0];
}

async function getJournalEntries(userId, limit = 20) {
    const r = await db.query(
        `SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [userId, limit]
    );
    return r.rows.reverse().map(e => ({
        id: e.id,
        date: e.created_at,
        weekNumber: e.week_number,
        // Entries written before migration 003 have energy/intentions and no note. Fall back
        // rather than showing a blank row -- old writing still counts.
        note: e.note || [e.energy, e.intentions].filter(Boolean).join('\n\n') || '',
        // The prompts consume a single string; keep that shape here so route handlers do not
        // each reinvent it.
        entry: e.note || [e.energy, e.intentions].filter(Boolean).join(' ') || ''
    }));
}

module.exports = {
    getActiveCycle, startCycle, endActiveCycle, advanceCycleWeek,
    addSubstitution, getSubstitutions,
    saveWeekPlan, getWeekPlan,
    appendWorkout, getWorkoutHistory, getSetsForMetrics,
    appendJournalEntry, getJournalEntries
};
