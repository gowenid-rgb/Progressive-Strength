// Generates fixtures.js for the cycle-snapshot prototype.
//
//   node prototypes/metrics/build-fixtures.js
//
// The prototype does NOT contain hand-written chart data. This script simulates a lifter
// double-progressing through cycles of different lengths, builds rows in the exact shape
// repo.getSetsForMetrics returns, and runs them through the REAL computeCycleSnapshot. What the
// page renders is therefore what the production endpoint would send.

const fs = require('fs');
const path = require('path');
const { computeCycleSnapshot } = require('../../cycleSnapshot');
const { phaseForWeek } = require('../../cycles');
const { canonicalName } = require('../../metrics');

function rng(seed) {                       // small deterministic PRNG so fixtures are stable
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Warm-ups first, as in a real session. `kind` drives the simulation only; what the page
// shows is decided by the library from `role`.
const LIFTS = [
    { name: 'Cat-Cow to Quadruped Rockback',               role: 'warmup',    lo: 10, hi: 10, sets: 1, w: null, kind: 'static' },
    { name: "World's Greatest Stretch with Thoracic Reach", role: 'warmup',    lo: 5,  hi: 5,  sets: 1, w: null, kind: 'static' },
    { name: 'Barbell Bench Press',    role: 'main',      lo: 6,  hi: 8,  sets: 4, w: 135, inc: 5,  kind: 'normal' },
    { name: 'Back Squat',             role: 'main',      lo: 5,  hi: 8,  sets: 4, w: 185, inc: 10, kind: 'normal' },
    { name: 'Incline Dumbbell Press', role: 'accessory', lo: 12, hi: 15, sets: 3, w: 35,  inc: 5,  kind: 'normal' },
    { name: 'Seated Cable Row',       role: 'accessory', lo: 10, hi: 12, sets: 3, w: 100, inc: 10, kind: 'normal' },
    { name: 'Overhead Press',         role: 'main',      lo: 8,  hi: 10, sets: 3, w: 85,  inc: 5,  kind: 'stalled' },
    { name: 'Romanian Deadlift',      role: 'main',      lo: 8,  hi: 10, sets: 3, w: 135, inc: 10, kind: 'normal', skipWeek: 4 },
    { name: 'Pull Ups',               role: 'main',      lo: 6,  hi: 12, sets: 3, w: null, kind: 'bodyweight' },
    { name: 'Hanging Knee Raises with Pelvic Tilt', role: 'core', lo: 12, hi: 15, sets: 3, w: null, kind: 'bodyweight' }
];

// Simulate `loggedWeeks` weeks of one lift. Returns [{week, weight, reps[]}].
function simulate(lift, loggedWeeks, total, rand, pace) {
    const out = [];
    let w = lift.w;
    let reps = Array.from({ length: lift.sets }, (_, j) => lift.lo + (j === 0 && lift.kind !== 'static' ? 1 : 0));
    for (let week = 1; week <= loggedWeeks; week++) {
        const skipped = lift.skipWeek && week === lift.skipWeek && loggedWeeks >= 7;
        const deload = week === total && total >= 4;
        if (!skipped) {
            if (deload && lift.kind !== 'static') {
                // A real deload: lighter, and fewer sets.
                const dw = w === null ? null : Math.round(w * 0.85 / 5) * 5;
                out.push({ week, weight: dw, reps: reps.slice(0, Math.max(1, lift.sets - 1)).map(r => Math.max(lift.lo, r - 1)) });
            } else {
                out.push({ week, weight: w, reps: reps.slice() });
            }
        }
        if (lift.kind === 'static') continue;                 // identical every week, on purpose
        if (lift.kind === 'stalled') {                        // wobbles inside the floor of the range
            reps = reps.map(r => Math.max(lift.lo - 1, Math.min(lift.lo + 1, r + (rand() < .5 ? -1 : 1) * (rand() < .6 ? 1 : 0))));
            continue;
        }
        if (lift.kind === 'bodyweight') {
            reps = reps.map(r => Math.min(lift.hi + 3, r + (rand() < .45 ? 1 : 0)));
            continue;
        }
        if (reps.every(r => r >= lift.hi)) {                  // double progression: top of range -> add weight
            w += lift.inc;
            reps = Array.from({ length: lift.sets }, (_, j) => lift.lo + (j === 0 ? 1 : 0));
        } else {
            reps = reps.map(r => Math.min(lift.hi, r + (rand() < pace ? 1 : 0)));
        }
    }
    return out;
}

function rowsFor(cycleId, loggedWeeks, total, seed, pace) {
    const rand = rng(seed), rows = [];
    for (const lift of LIFTS) {
        for (const e of simulate(lift, loggedWeeks, total, rand, pace)) {
            e.reps.forEach(r => rows.push({
                workout_id: cycleId * 1000 + e.week, finished_at: new Date(2026, 5, e.week * 7).toISOString(),
                cycle_id: cycleId, week_number: e.week, exercise_name: lift.name,
                weight_value: e.weight, weight_unit: 'lb', is_bodyweight: e.weight === null,
                reps_value: r, swapped_from: null
            }));
        }
    }
    return rows;
}

function program(totalWeeks) {
    return {
        programName: 'Full-Body Triad: Hypertrophy & Power',
        days: [{ dayName: 'Day 1', exercises: LIFTS.map(l => ({ name: l.name, role: l.role, repRange: `${l.lo}-${l.hi}`, baseSets: l.sets })) }],
        weeks: Array.from({ length: totalWeeks }, (_, i) => ({ week: i + 1, phase: phaseForWeek(i + 1, totalWeeks), intent: '' }))
    };
}

const SCENARIOS = [
    { key: '4w',  label: '4 wk',         total: 4,  logged: 3,  prevTotal: null, seed: 4 },
    { key: '6w',  label: '6 wk',         total: 6,  logged: 5,  prevTotal: 6,    seed: 6 },
    { key: '6d',  label: '6 wk · done',  total: 6,  logged: 6,  prevTotal: 6,    seed: 6 },
    { key: '6o',  label: '6 wk · OHP off', total: 6, logged: 5, prevTotal: 6,  seed: 6, off: ['Overhead Press'] },
    { key: '8w',  label: '8 wk',         total: 8,  logged: 6,  prevTotal: 6,    seed: 8 },
    { key: '12w', label: '12 wk',        total: 12, logged: 9,  prevTotal: 10,   seed: 12 },
    { key: '12e', label: '12 wk · wk 2', total: 12, logged: 2,  prevTotal: 10,   seed: 21 },
    { key: '12n', label: '12 wk · wk 1', total: 12, logged: 1,  prevTotal: 10,   seed: 22 }
];

const out = SCENARIOS.map(sc => {
    const cycle = { id: 2, name: 'Full-Body Triad: Hypertrophy & Power', total_weeks: sc.total, program: program(sc.total) };
    // The lifter switched these lifts off (POST /api/cycle/tracking), stored per cycle by canonical name.
    if (sc.off) cycle.tracking_overrides = Object.fromEntries(sc.off.map(n => [canonicalName(n), 'consistency']));
    let rows = rowsFor(2, sc.logged, sc.total, sc.seed, .62);
    let previousCycle = null;
    if (sc.prevTotal) {
        previousCycle = { id: 1, name: 'Previous cycle', total_weeks: sc.prevTotal, program: program(sc.prevTotal) };
        rows = rows.concat(rowsFor(1, sc.prevTotal, sc.prevTotal, sc.seed + 100, .5));
    }
    return { key: sc.key, label: sc.label, snapshot: computeCycleSnapshot(rows, cycle, { previousCycle }) };
});

fs.writeFileSync(path.join(__dirname, 'fixtures.js'),
    '// GENERATED by build-fixtures.js from the real computeCycleSnapshot. Do not edit.\n' +
    'window.SNAPSHOTS = ' + JSON.stringify(out) + ';\n');
out.forEach(s => {
    const sm = s.snapshot.summary;
    console.log(s.label.padEnd(14), 'strength', String(sm.strengthPct).padEnd(5), '| judged', sm.liftsTracked, '| warm-up', JSON.stringify(sm.untracked),
        '| logged through', s.snapshot.loggedThrough, '| prev', s.snapshot.previous ? s.snapshot.previous.strengthPct : null);
});
