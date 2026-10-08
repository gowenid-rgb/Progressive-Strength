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

/**
 * Changes the length of the active cycle.
 *
 * Needed because cycle length was previously fixed at creation with no way to correct it, and
 * cycles created before the length picker existed were silently one week long — permanently
 * "complete" with no way forward that did not throw the cycle away.
 */
async function setCycleLength(cycleId, totalWeeks) {
    const r = await db.query(
        `UPDATE cycles SET total_weeks = $2
          WHERE id = $1 AND status = 'active' AND $2 >= current_week
          RETURNING *`,
        [cycleId, totalWeeks]
    );
    return r.rows[0] || null;
}

/**
 * Records the lifter's correction to how one movement is tracked in this cycle.
 * mode: 'progress' | 'consistency', or null to remove the correction and fall back to the
 * programme's role. Keyed by canonical name so a re-spelled movement keeps its setting.
 */
async function setTrackingOverride(cycleId, key, mode) {
    const r = mode === null
        ? await db.query(
            `UPDATE cycles SET tracking_overrides = COALESCE(tracking_overrides, '{}'::jsonb) - $2::text
              WHERE id = $1 AND status = 'active' RETURNING *`, [cycleId, key])
        : await db.query(
            `UPDATE cycles SET tracking_overrides = COALESCE(tracking_overrides, '{}'::jsonb) || $2::jsonb
              WHERE id = $1 AND status = 'active' RETURNING *`, [cycleId, JSON.stringify({ [key]: mode })]);
    return r.rows[0] || null;
}

async function setCycleProgram(cycleId, program) {
    const r = await db.query(
        `UPDATE cycles SET program = $2 WHERE id = $1 AND status = 'active' RETURNING *`,
        [cycleId, JSON.stringify(program)]
    );
    return r.rows[0] || null;
}

/**
 * The last few finished or abandoned cycles, with their programmes, for designing the next one.
 *
 * An abandoned cycle is included deliberately: stopping in week 3 twice is a real signal about
 * what to programme next, and dropping it would throw that away.
 */
async function getPreviousCycles(userId, limit = 3) {
    const r = await db.query(
        `SELECT id, name, goal, total_weeks, current_week, status, program, created_at, completed_at
           FROM cycles
          WHERE user_id = $1 AND status <> 'active'
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit]
    );
    return r.rows;
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
async function insertWorkout(userId, workout, clientId) {
    const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];

    return db.withTransaction(async client => {
        const w = await client.query(
            `INSERT INTO workouts
                (user_id, cycle_id, week_number, day_index, day_name, plan_name,
                 notes, started_at, finished_at, duration_seconds, client_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now()),$10,$11)
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
                workout.durationSeconds || null,
                clientId
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
        `SELECT * FROM workouts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY finished_at DESC, id DESC LIMIT $2`,
        [userId, limit]
    );
    if (ws.rows.length === 0) return [];

    const ids = ws.rows.map(r => r.id);
    const ss = await db.query(
        `SELECT * FROM workout_sets WHERE workout_id = ANY($1::int[]) AND deleted_at IS NULL
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
                s.reps_value, s.swapped_from, w.day_index, w.day_name
           FROM workouts w
           JOIN workout_sets s ON s.workout_id = w.id
          WHERE w.user_id = $1 AND w.deleted_at IS NULL AND s.deleted_at IS NULL
          ORDER BY w.finished_at ASC, w.id ASC, s.exercise_order ASC, s.set_number ASC`,
        [userId]
    );
    return r.rows;
}

/**
 * Saves a finished session. Idempotent when the caller supplies a clientId: the same session
 * posted twice (a double tap, a retry, a device re-uploading what it holds) returns the original
 * and creates nothing. Soft-deleted sessions keep their id, so a stale device cannot bring a
 * deleted session back by re-uploading it.
 */
async function appendWorkout(userId, workout) {
    const clientId = workout.clientId ? String(workout.clientId).slice(0, 200) : null;
    const existing = async () => {
        const r = await db.query('SELECT * FROM workouts WHERE user_id = $1 AND client_id = $2', [userId, clientId]);
        return r.rows[0] ? Object.assign({}, r.rows[0], { duplicate: true }) : null;
    };

    if (clientId) {
        const found = await existing();
        if (found) return found;
    }
    try {
        return await insertWorkout(userId, workout, clientId);
    } catch (err) {
        // Two identical requests racing: the unique index lets exactly one win.
        if (clientId && err && err.code === '23505') {
            const found = await existing();
            if (found) return found;
        }
        throw err;
    }
}

/**
 * Distinct movement names the user has actually logged, most recent first.
 *
 * Fed back into generation prompts so the model reuses the name it used last week instead of
 * inventing a new spelling. Name drift between weeks is what silently split one lift into
 * several in the metrics.
 */
async function getKnownExerciseNames(userId, limit = 60) {
    const r = await db.query(
        `SELECT s.exercise_name, MAX(w.finished_at) AS last_seen
           FROM workouts w
           JOIN workout_sets s ON s.workout_id = w.id
          WHERE w.user_id = $1 AND w.deleted_at IS NULL AND s.deleted_at IS NULL
          GROUP BY s.exercise_name
          ORDER BY last_seen DESC
          LIMIT $2`,
        [userId, limit]
    );
    return r.rows.map(x => x.exercise_name);
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

/* ----------------------------------------------------------- weekly reviews */

/** The saved coach review for one cycle week, or null. */
async function getWeeklyReview(cycleId, weekNumber) {
    const r = await db.query(
        `SELECT review, sessions, generated_at FROM weekly_reviews WHERE cycle_id = $1 AND week_number = $2`,
        [cycleId, weekNumber]
    );
    return r.rows[0] || null;
}

/** Stores a review, replacing any earlier one for the same cycle week. */
async function saveWeeklyReview(userId, cycleId, weekNumber, review, sessions) {
    const r = await db.query(
        `INSERT INTO weekly_reviews (user_id, cycle_id, week_number, review, sessions)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cycle_id, week_number)
         DO UPDATE SET review = EXCLUDED.review, sessions = EXCLUDED.sessions, generated_at = now()
         RETURNING review, sessions, generated_at`,
        [userId, cycleId, weekNumber, JSON.stringify(review), sessions]
    );
    return r.rows[0];
}

/* ------------------------------------------------------- correcting history */
//
// Corrections are SOFT. A deleted set or session keeps its row (deleted_at) and an edit keeps its
// old values in workout_edits, so correcting a mistake never destroys what the lifter logged, and
// any correction can be reversed by hand. Every read of history ignores soft-deleted rows.

class EditError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

const audit = (client, userId, workoutId, setId, action, before, after) => client.query(
    `INSERT INTO workout_edits (user_id, workout_id, set_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, workoutId, setId, action,
        before === null || before === undefined ? null : JSON.stringify(before),
        after === null || after === undefined ? null : JSON.stringify(after)]
);

async function ownedWorkout(client, userId, workoutId) {
    const r = await client.query(
        `SELECT * FROM workouts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [workoutId, userId]
    );
    if (!r.rows[0]) throw new EditError('That workout was not found', 404);
    return r.rows[0];
}

async function ownedSet(client, userId, workoutId, setId) {
    await ownedWorkout(client, userId, workoutId);
    const r = await client.query(
        `SELECT * FROM workout_sets WHERE id = $1 AND workout_id = $2 AND deleted_at IS NULL`, [setId, workoutId]
    );
    if (!r.rows[0]) throw new EditError('That set was not found', 404);
    return r.rows[0];
}

// An edit is deliberate, unlike a number typed mid-set, so it is held to a stricter standard than
// the logger: reps must be a number, and weight must be a number or BW. Logging stays forgiving.
function parseEdit(weight, reps) {
    const w = parseWeight(weight === undefined || weight === null || String(weight).trim() === '' ? 'BW' : weight);
    const r = parseReps(reps);
    if (r.value === null) throw new EditError('Reps must be a number');
    if (r.value > 1000) throw new EditError('That rep count looks wrong');
    if (!w.isBodyweight && w.value === null) throw new EditError('Weight must be a number, or BW for bodyweight');
    if (w.value !== null && w.value > 5000) throw new EditError('That weight looks wrong');
    return { w, r };
}

const rawOf = s => ({ weight: s.weight_raw, reps: s.reps_raw });

/** Every live workout, with the ids needed to correct it. Oldest first. */
async function listWorkouts(userId) {
    const ws = await db.query(
        `SELECT id, cycle_id, week_number, day_index, day_name, plan_name, finished_at
           FROM workouts WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY finished_at ASC, id ASC`,
        [userId]
    );
    if (ws.rows.length === 0) return [];
    const ids = ws.rows.map(w => w.id);
    const ss = await db.query(
        `SELECT id, workout_id, exercise_name, exercise_order, set_number, weight_raw, reps_raw,
                weight_value, is_bodyweight, reps_value, edited_at
           FROM workout_sets WHERE workout_id = ANY($1::int[]) AND deleted_at IS NULL
          ORDER BY workout_id, exercise_order, set_number, id`,
        [ids]
    );

    const byWorkout = new Map(ids.map(id => [id, new Map()]));
    for (const s of ss.rows) {
        const m = byWorkout.get(s.workout_id);
        const key = s.exercise_order + '|' + s.exercise_name;
        if (!m.has(key)) m.set(key, { name: s.exercise_name, sets: [] });
        m.get(key).sets.push({
            id: s.id,
            set: s.set_number,
            weight: s.is_bodyweight && !s.weight_raw ? 'BW' : s.weight_raw,
            reps: s.reps_raw,
            isBodyweight: s.is_bodyweight,
            edited: !!s.edited_at
        });
    }

    // Two sessions with the same day and the same instant are what a repeated upload produces.
    const seen = new Map();
    return ws.rows.map(w => {
        const stamp = new Date(w.finished_at).getTime() + '|' + (w.day_name || '');
        const first = seen.get(stamp);
        if (first === undefined) seen.set(stamp, w.id);
        return {
            id: w.id,
            cycleId: w.cycle_id,
            weekNumber: w.week_number,
            dayIndex: w.day_index,
            dayName: w.day_name,
            date: w.finished_at,
            possibleDuplicateOf: first === undefined ? null : first,
            exercises: Array.from(byWorkout.get(w.id).values())
        };
    });
}

async function updateSet(userId, workoutId, setId, input) {
    return db.withTransaction(async client => {
        const before = await ownedSet(client, userId, workoutId, setId);
        const { w, r } = parseEdit(input.weight, input.reps);
        await client.query(
            `UPDATE workout_sets
                SET weight_value = $2, weight_unit = $3, is_bodyweight = $4, reps_value = $5,
                    weight_raw = $6, reps_raw = $7, edited_at = now()
              WHERE id = $1`,
            [setId, w.value, w.unit, w.isBodyweight, r.value, w.isBodyweight ? 'BW' : w.raw, r.raw]
        );
        await audit(client, userId, workoutId, setId, 'edit_set', rawOf(before), { weight: w.isBodyweight ? 'BW' : w.raw, reps: r.raw });
    });
}

/** Removes a set; removes the session too if that was its last set, so no empty sessions linger. */
async function deleteSet(userId, workoutId, setId) {
    return db.withTransaction(async client => {
        const before = await ownedSet(client, userId, workoutId, setId);
        await client.query(`UPDATE workout_sets SET deleted_at = now() WHERE id = $1`, [setId]);
        await audit(client, userId, workoutId, setId, 'delete_set', Object.assign({ exercise: before.exercise_name }, rawOf(before)), null);

        const left = await client.query(
            `SELECT 1 FROM workout_sets WHERE workout_id = $1 AND deleted_at IS NULL LIMIT 1`, [workoutId]
        );
        if (left.rows.length === 0) {
            await client.query(`UPDATE workouts SET deleted_at = now() WHERE id = $1`, [workoutId]);
            await audit(client, userId, workoutId, null, 'delete_workout', { reason: 'last set removed' }, null);
            return { workoutRemoved: true };
        }
        return { workoutRemoved: false };
    });
}

async function addSet(userId, workoutId, input) {
    return db.withTransaction(async client => {
        await ownedWorkout(client, userId, workoutId);
        const name = String(input.exercise || '').trim();
        const existing = await client.query(
            `SELECT exercise_order, MAX(set_number) AS last, MAX(swapped_from) AS swapped_from
               FROM workout_sets WHERE workout_id = $1 AND exercise_name = $2
              GROUP BY exercise_order ORDER BY exercise_order LIMIT 1`,
            [workoutId, name]
        );
        if (!existing.rows[0]) throw new EditError('That movement is not in this workout', 404);

        const { w, r } = parseEdit(input.weight, input.reps);
        const ins = await client.query(
            `INSERT INTO workout_sets
                (workout_id, exercise_name, exercise_order, set_number, weight_value, weight_unit,
                 is_bodyweight, reps_value, weight_raw, reps_raw, swapped_from)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [workoutId, name, existing.rows[0].exercise_order, Number(existing.rows[0].last) + 1,
                w.value, w.unit, w.isBodyweight, r.value, w.isBodyweight ? 'BW' : w.raw, r.raw, existing.rows[0].swapped_from || null]
        );
        await audit(client, userId, workoutId, ins.rows[0].id, 'add_set', null, { exercise: name, weight: w.isBodyweight ? 'BW' : w.raw, reps: r.raw });
        return { id: ins.rows[0].id };
    });
}

async function deleteWorkout(userId, workoutId) {
    return db.withTransaction(async client => {
        const w = await ownedWorkout(client, userId, workoutId);
        await client.query(`UPDATE workout_sets SET deleted_at = now() WHERE workout_id = $1 AND deleted_at IS NULL`, [workoutId]);
        await client.query(`UPDATE workouts SET deleted_at = now() WHERE id = $1`, [workoutId]);
        await audit(client, userId, workoutId, null, 'delete_workout', { week: w.week_number, day: w.day_name }, null);
    });
}

/**
 * Moves a session to another week. A session that was never attached to a cycle (it had no
 * active cycle when it was saved) is attached to the active one, which is how an "unplaced"
 * workout gets onto the scorecard.
 */
async function moveWorkout(userId, workoutId, weekNumber) {
    return db.withTransaction(async client => {
        const w = await ownedWorkout(client, userId, workoutId);
        const week = Number(weekNumber);
        if (!Number.isInteger(week) || week < 1) throw new EditError('Choose a week number');

        let cycleId = w.cycle_id;
        if (cycleId === null) {
            const active = await client.query(`SELECT id FROM cycles WHERE user_id = $1 AND status = 'active' LIMIT 1`, [userId]);
            if (!active.rows[0]) throw new EditError('There is no active cycle to attach this workout to');
            cycleId = active.rows[0].id;
        }
        const c = await client.query(`SELECT total_weeks FROM cycles WHERE id = $1`, [cycleId]);
        if (c.rows[0] && week > Number(c.rows[0].total_weeks)) throw new EditError('That cycle only has ' + c.rows[0].total_weeks + ' weeks');

        await client.query(`UPDATE workouts SET week_number = $2, cycle_id = $3 WHERE id = $1`, [workoutId, week, cycleId]);
        await audit(client, userId, workoutId, null, 'move_workout', { week: w.week_number, cycleId: w.cycle_id }, { week, cycleId });
    });
}

/** Renames one movement within one session, for a movement logged under the wrong name. */
async function renameExercise(userId, workoutId, from, to) {
    return db.withTransaction(async client => {
        await ownedWorkout(client, userId, workoutId);
        const next = String(to || '').trim();
        if (!next) throw new EditError('A movement needs a name');
        if (next.length > 120) throw new EditError('That name is too long');
        const r = await client.query(
            `UPDATE workout_sets SET exercise_name = $3, edited_at = now()
              WHERE workout_id = $1 AND exercise_name = $2 AND deleted_at IS NULL
          RETURNING id`,
            [workoutId, String(from || ''), next]
        );
        if (r.rows.length === 0) throw new EditError('That movement is not in this workout', 404);
        await audit(client, userId, workoutId, null, 'rename_exercise', { name: from }, { name: next });
    });
}

module.exports = {
    listWorkouts, updateSet, deleteSet, addSet, deleteWorkout, moveWorkout, renameExercise, EditError,
    getWeeklyReview, saveWeeklyReview,
    getActiveCycle, startCycle, endActiveCycle, advanceCycleWeek, setCycleLength,
    setCycleProgram, setTrackingOverride, getPreviousCycles,
    addSubstitution, getSubstitutions,
    saveWeekPlan, getWeekPlan,
    appendWorkout, getWorkoutHistory, getSetsForMetrics, getKnownExerciseNames,
    appendJournalEntry, getJournalEntries
};
