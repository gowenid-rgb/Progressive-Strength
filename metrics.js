// Training aggregates.
//
// This is not really a screen. It is the layer that turns normalised sets into numbers, and
// it has two consumers: the Metrics dashboard, and eventually the long-term AI review
// (T3-12). A year of raw sets will not fit a context window at sensible cost, so the AI has
// to read the same computed summary the dashboard renders.
//
// Deliberately a PURE FUNCTION over rows. No database, no clock of its own — `now` is passed
// in — so every boundary case is testable without fixtures or timing luck.

const LB_PER_KG = 2.2046226218;

/** Normalises a stored weight to pounds. Returns null when there is no usable number. */
function toPounds(row) {
    if (row.is_bodyweight) return null;
    if (row.weight_value === null || row.weight_value === undefined) return null;
    const v = Number(row.weight_value);
    if (!Number.isFinite(v)) return null;
    return row.weight_unit === 'kg' ? v * LB_PER_KG : v;
}

// Words that describe the same movement regardless of where a language model puts them.
// Deliberately NOT stripped: barbell, dumbbell, machine, cable. Those change the load, so
// merging "Barbell Bench Press" with "Dumbbell Bench Press" would draw a chart that falls off
// a cliff between two unrelated lifts. Under-merging shows less; over-merging shows something
// false, which is worse.
const NAME_NOISE = new Set(['the', 'a', 'an', 'with', 'and', 'grip', 'style']);

/**
 * Groups exercise names that are the same movement written differently.
 *
 * Names come from a language model and drift between weeks: "Barbell Bench Press" one week,
 * "Bench Press (Barbell)" the next. Grouped by exact string, that is two movements with one
 * session each — no progression line, and a best-sets list full of near-duplicates. Which is
 * exactly what "the graphs aren't working" looked like.
 *
 * Sorting the words makes word ORDER and punctuation irrelevant while keeping the word SET
 * significant, so equipment differences still separate properly.
 */
function canonicalName(name) {
    return String(name === null || name === undefined ? '' : name)
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(w => !NAME_NOISE.has(w))
        .sort()
        .join(' ');
}

function startOfWeek(now) {
    // Monday. Training weeks are talked about as Monday-to-Sunday, and a Sunday session
    // landing in "next week" reads as a bug to anyone looking at it.
    const d = new Date(now);
    const day = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d;
}

function startOfMonth(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d;
}

function startOfYear(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setMonth(0, 1);
    return d;
}

/**
 * @param rows Joined set rows, one per logged set:
 *   { workout_id, finished_at, exercise_name, weight_value, weight_unit,
 *     is_bodyweight, reps_value, swapped_from }
 * @param now  Reference time for the period buckets.
 */
function computeMetrics(rows, now = new Date()) {
    const list = Array.isArray(rows) ? rows : [];

    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);
    const yearStart = startOfYear(now);

    const workouts = new Map();      // workout_id -> { date, volume, sets }
    const movements = new Map();     // exercise name -> aggregate
    let totalSets = 0;

    for (const r of list) {
        const date = new Date(r.finished_at);
        const pounds = toPounds(r);
        const reps = Number.isFinite(Number(r.reps_value)) ? Number(r.reps_value) : null;

        // Bodyweight sets contribute no volume: the app does not know the user's bodyweight,
        // and inventing one would corrupt the very history the AI reads back. They still
        // count as sets and still count toward the workout.
        const volume = (pounds !== null && reps !== null) ? pounds * reps : 0;

        if (!workouts.has(r.workout_id)) {
            workouts.set(r.workout_id, { date, volume: 0, sets: 0 });
        }
        const w = workouts.get(r.workout_id);
        w.volume += volume;
        w.sets += 1;
        totalSets += 1;

        // Keyed by canonical form, displayed under the most recent spelling — that is what
        // the user's current plan calls it, so it is the name they will recognise.
        const name = r.exercise_name;
        const key = canonicalName(name) || String(name || '').toLowerCase();
        if (!movements.has(key)) {
            movements.set(key, {
                name, aliases: new Set(), sessions: new Set(), sets: 0, volume: 0,
                best: null, points: new Map()
            });
        }
        const m = movements.get(key);
        m.aliases.add(name);
        // Rows arrive oldest-first, so the last write wins and the newest spelling sticks.
        m.name = name;
        m.sessions.add(r.workout_id);
        m.sets += 1;
        m.volume += volume;

        if (pounds !== null && reps !== null) {
            if (!m.best || pounds > m.best.weight ||
                (pounds === m.best.weight && reps > m.best.reps)) {
                m.best = { weight: pounds, reps, date };
            }
            // Best set of that session: the headline a lifter actually tracks.
            const prev = m.points.get(r.workout_id);
            if (!prev || pounds > prev.weight || (pounds === prev.weight && reps > prev.reps)) {
                m.points.set(r.workout_id, { date, weight: pounds, reps });
            }
        }
    }

    const allWorkouts = Array.from(workouts.values()).sort((a, b) => a.date - b.date);
    const since = d => allWorkouts.filter(w => w.date >= d);

    const sumVolume = ws => ws.reduce((t, w) => t + w.volume, 0);

    const movementList = Array.from(movements.values())
        .map(m => ({
            name: m.name,
            // Surfaced so a name that drifted is visible rather than mysterious.
            aliases: Array.from(m.aliases).filter(a => a !== m.name),
            sessions: m.sessions.size,
            sets: m.sets,
            volume: Math.round(m.volume),
            best: m.best ? { weight: Math.round(m.best.weight * 10) / 10, reps: m.best.reps, date: m.best.date } : null,
            points: Array.from(m.points.values())
                .sort((a, b) => a.date - b.date)
                .map(p => ({ date: p.date, weight: Math.round(p.weight * 10) / 10, reps: p.reps }))
        }))
        .sort((a, b) => b.sessions - a.sessions || b.volume - a.volume);

    return {
        unit: 'lb',
        generatedAt: new Date(now).toISOString(),
        counts: {
            week: since(weekStart).length,
            month: since(monthStart).length,
            year: since(yearStart).length,
            allTime: allWorkouts.length
        },
        volume: {
            week: Math.round(sumVolume(since(weekStart))),
            month: Math.round(sumVolume(since(monthStart))),
            year: Math.round(sumVolume(since(yearStart))),
            allTime: Math.round(sumVolume(allWorkouts))
        },
        totalSets,
        firstWorkout: allWorkouts.length ? allWorkouts[0].date : null,
        lastWorkout: allWorkouts.length ? allWorkouts[allWorkouts.length - 1].date : null,
        // Only movements with two or more sessions can show a trend; one point is not a line.
        // Kept separate from `movements` so the client does not have to re-filter.
        trendable: movementList.filter(m => m.points.length >= 2).map(m => m.name),
        movements: movementList
    };
}

module.exports = { computeMetrics, canonicalName, toPounds, startOfWeek, startOfMonth, startOfYear, LB_PER_KG };
