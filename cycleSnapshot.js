// The cycle snapshot: everything the Metrics scorecard needs to draw one training cycle.
//
// Like metrics.js this is a PURE FUNCTION over rows — no database, no clock — so every
// boundary (a missed week, a cycle of 4 or 12 weeks, a bodyweight lift) is tested directly.
//
// What it answers, per cycle:
//   - How did each lift move, week by week? (more weight / more reps / held / slipped)
//   - How much stronger is the lifter overall, as ONE number, and where did it come from?
//   - How does the trajectory compare with the previous cycle?
//
// "Progress" here is deliberately not "heaviest set". Under double progression a lifter can
// gain a rep on one set, or move one set up in weight, and that is real progress that a
// top-weight line cannot see. Each lift therefore carries its estimated one-rep max (Epley,
// best set of the week) alongside the raw loads and reps.
//
// Not every movement is judged on progress. A warm-up done identically each week is doing its
// job, so each lift carries a tracking MODE:
//   progress     arrows, flags, and a share of the headline number (the default)
//   consistency  only "was it done?" — no arrows, no "stalling", left out of every total
// The mode comes from the movement's role in the programme, and the lifter can override it.
//
// Deload weeks are tracked and shown (completing one matters) but flagged. They are never
// counted as "slipped", and the week after a deload is compared with the week BEFORE it —
// otherwise coming back to normal weights would read as a burst of progress.

const { canonicalName, toPounds } = require('./metrics');
const { parseRepRange, normaliseRole, trackingModeFor } = require('./program');
const { phaseForWeek, PHASES } = require('./cycles');

const round1 = n => Math.round(n * 10) / 10;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const epley = (w, r) => w * (1 + r / 30);

/** Reduces one week's sets for one lift to the numbers the scorecard compares. */
function summariseWeek(week, sets) {
    const reps = sets.reduce((t, s) => t + s.reps, 0);
    const weighted = sets.filter(s => s.weight !== null);
    let best = null;
    for (const s of weighted) {
        if (!best || epley(s.weight, s.reps) > epley(best.weight, best.reps)) best = s;
    }
    return {
        week,
        sets: sets.map(s => ({ weight: s.weight === null ? null : round1(s.weight), reps: s.reps })),
        reps,
        volume: Math.round(weighted.reduce((t, s) => t + s.weight * s.reps, 0)),
        top: weighted.length ? round1(Math.max(...weighted.map(s => s.weight))) : null,
        best: best ? { weight: round1(best.weight), reps: best.reps } : null,
        e1rm: best ? round1(epley(best.weight, best.reps)) : null
    };
}

/**
 * How this week compared with the lift's previous LOGGED week.
 * Any set getting heavier counts first, then more total reps — both are progress, and the
 * old heaviest-set chart could only ever see the first.
 */
function compare(prev, cur) {
    if (!prev) return { kind: 'start' };
    if (cur.top !== null && prev.top !== null) {
        if (cur.top > prev.top) return { kind: 'load', amount: round1(cur.top - prev.top) };
        if (cur.top < prev.top) return { kind: 'down', amount: round1(cur.top - prev.top), unit: 'lb' };
    }
    if (cur.reps > prev.reps) return { kind: 'reps', amount: cur.reps - prev.reps };
    if (cur.reps === prev.reps) return { kind: 'hold', amount: 0 };
    return { kind: 'down', amount: cur.reps - prev.reps, unit: 'reps' };
}

function rangeLookup(program) {
    const out = new Map();
    const days = program && Array.isArray(program.days) ? program.days : [];
    for (const d of days) {
        for (const e of (Array.isArray(d.exercises) ? d.exercises : [])) {
            const r = parseRepRange(e.repRange || e.reps);
            if (r && e.name) out.set(canonicalName(e.name), r);
        }
    }
    return out;
}

function roleLookup(program) {
    const out = new Map();
    const days = program && Array.isArray(program.days) ? program.days : [];
    for (const d of days) {
        for (const e of (Array.isArray(d.exercises) ? d.exercises : [])) {
            if (e && e.name && e.role) out.set(canonicalName(e.name), normaliseRole(e.role));
        }
    }
    return out;
}

function phaseList(cycle, totalWeeks) {
    const specs = cycle.program && Array.isArray(cycle.program.weeks) ? cycle.program.weeks : [];
    return Array.from({ length: totalWeeks }, (_, i) => {
        const spec = specs.find(w => Number(w.week) === i + 1);
        const key = spec && PHASES[spec.phase] ? spec.phase : phaseForWeek(i + 1, totalWeeks);
        return { week: i + 1, key, label: PHASES[key].label };
    });
}

function build(rows, cycle) {
    const list = Array.isArray(rows) ? rows : [];
    const mine = list.filter(r => Number(r.cycle_id) === Number(cycle.id) && Number(r.week_number) >= 1);

    // A cycle can be shortened after sessions were logged; never drop data for being "too late".
    const observedMax = mine.reduce((m, r) => Math.max(m, Number(r.week_number)), 0);
    const totalWeeks = Math.max(Number(cycle.total_weeks) || 1, observedMax);
    const ranges = rangeLookup(cycle.program);
    const roles = roleLookup(cycle.program);
    const overrides = (cycle.tracking_overrides && typeof cycle.tracking_overrides === 'object') ? cycle.tracking_overrides : {};
    const phases = phaseList(cycle, totalWeeks);
    const isDeload = w => phases[w - 1].key === 'deload';

    // lift -> week -> sets. Rows arrive oldest-first, so the newest spelling wins the display name
    // and the Map's insertion order is the order the lifts are first trained.
    const lifts = new Map();
    for (const r of mine) {
        const reps = Number(r.reps_value);
        if (!Number.isFinite(reps)) continue;
        const key = canonicalName(r.exercise_name) || String(r.exercise_name || '').toLowerCase();
        if (!lifts.has(key)) lifts.set(key, { key, name: r.exercise_name, weeks: new Map() });
        const l = lifts.get(key);
        l.name = r.exercise_name;
        const w = Number(r.week_number);
        if (!l.weeks.has(w)) l.weeks.set(w, []);
        l.weeks.get(w).push({ weight: toPounds(r), reps });
    }

    const movements = [];
    for (const l of lifts.values()) {
        const role = roles.get(l.key) || null;
        const override = overrides[l.key] === 'progress' || overrides[l.key] === 'consistency' ? overrides[l.key] : null;
        const mode = override || (role ? trackingModeFor(role) : 'progress');

        const weeks = Array(totalWeeks).fill(null);
        let prev = null;                      // last logged NON-deload week: what the next week is compared with
        let moved = 0, possible = 0;
        const recent = [];
        for (let w = 1; w <= totalWeeks; w++) {
            if (!l.weeks.has(w)) continue;
            const s = summariseWeek(w, l.weeks.get(w));
            s.deload = isDeload(w);
            if (mode === 'consistency') {
                s.delta = { kind: 'done' };
            } else {
                s.delta = compare(prev, s);
                if (s.deload) {
                    // Shown, but never judged: fewer pounds on purpose is the plan working.
                } else {
                    if (s.delta.kind !== 'start') {
                        possible++;
                        const forward = s.delta.kind === 'load' || s.delta.kind === 'reps';
                        if (forward) moved++;
                        recent.push(forward);
                    }
                    prev = s;
                }
            }
            weeks[w - 1] = s;
        }
        const logged = weeks.filter(Boolean);
        if (!logged.length) continue;

        // Baseline and "latest" skip deload weeks: a cycle that ends on its deload should not
        // report that you got weaker.
        const working = logged.filter(x => !x.deload);
        const basis = working.length ? working : logged;
        const first = basis[0], latest = basis[basis.length - 1];
        const range = ranges.get(l.key) || null;
        const tracked = mode === 'progress' && basis.length >= 2 && first.e1rm !== null && latest.e1rm !== null;

        // Exact split of the e1RM change into "heavier weight" and "more reps":
        //   w2(1+r2/30) - w1(1+r1/30) = (w2-w1)(1+r1/30) + w2(r2-r1)/30
        let changePct = null, fromWeightPct = null, fromRepsPct = null, loadChange = null;
        if (tracked) {
            const a = first.best, b = latest.best, e0 = first.e1rm;
            changePct = (latest.e1rm / e0 - 1) * 100;
            fromWeightPct = (b.weight - a.weight) * (1 + a.reps / 30) / e0 * 100;
            fromRepsPct = b.weight * (b.reps - a.reps) / 30 / e0 * 100;
            loadChange = round1(latest.top - first.top);
        }

        movements.push({
            name: l.name,
            role,
            mode,
            modeSource: override ? 'override' : role ? 'role' : 'default',
            range,
            weeks,
            baselineWeek: first.week,
            latestWeek: logged[logged.length - 1].week,
            tracked,
            changePct: changePct === null ? null : round1(changePct),
            fromWeightPct: fromWeightPct === null ? null : round1(fromWeightPct),
            fromRepsPct: fromRepsPct === null ? null : round1(fromRepsPct),
            loadChange,
            weeksMoved: moved,
            weeksCompared: possible,
            weeksDone: mode === 'consistency' ? logged.length : null,
            // Every set at the top of the target range: the double-progression trigger.
            readyForMore: mode === 'progress' && !!(range && latest.sets.length && latest.sets.every(s => s.reps >= range.max)),
            // Needs three comparisons of history before it is fair to call a lift stalled.
            stalling: mode === 'progress' && recent.length >= 3 && recent.slice(-3).filter(Boolean).length <= 1,
            _first: first
        });
    }

    const trackedLifts = movements.filter(m => m.tracked);

    // Each week's cycle number: the average e1RM change of every tracked lift that was logged
    // that week, each measured against its OWN first logged week.
    const byWeek = Array.from({ length: totalWeeks }, (_, i) => {
        const vals = trackedLifts
            .filter(m => m.weeks[i] && m.weeks[i].e1rm !== null && i + 1 >= m.baselineWeek)
            .map(m => (m.weeks[i].e1rm / m._first.e1rm - 1) * 100);
        return vals.length ? round1(mean(vals)) : null;
    });

    const loggedThrough = movements.reduce((m, x) => Math.max(m, x.latestWeek), 0);
    const compared = movements.reduce((t, m) => t + m.weeksCompared, 0);
    const won = movements.reduce((t, m) => t + m.weeksMoved, 0);

    // Consistency movements: done / expected, counted from the week each was first logged.
    const quiet = movements.filter(m => m.mode === 'consistency');
    const quietPossible = quiet.reduce((t, m) => t + (loggedThrough - m.weeks.findIndex(Boolean)), 0);
    const quietDone = quiet.reduce((t, m) => t + m.weeksDone, 0);

    const snapshot = {
        unit: 'lb',
        cycleId: cycle.id,
        name: cycle.name || (cycle.program && cycle.program.programName) || null,
        totalWeeks,
        loggedThrough,
        phases,
        summary: {
            // null until at least one lift has two logged weeks: one point is not a change.
            strengthPct: trackedLifts.length ? round1(mean(trackedLifts.map(m => m.changePct))) : null,
            fromWeightPct: trackedLifts.length ? round1(mean(trackedLifts.map(m => m.fromWeightPct))) : null,
            fromRepsPct: trackedLifts.length ? round1(mean(trackedLifts.map(m => m.fromRepsPct))) : null,
            liftsUp: trackedLifts.filter(m => m.changePct > 0).length,
            liftsTracked: trackedLifts.length,
            weeksWon: won,
            weeksCompared: compared,
            untracked: { movements: quiet.length, weeksDone: quietDone, weeksPossible: quietPossible },
            avgLoadAdded: trackedLifts.length ? round1(mean(trackedLifts.map(m => m.loadChange))) : null,
            byWeek
        },
        movements: movements.map(({ _first, ...m }) => m)
    };
    return snapshot;
}

/**
 * @param rows   Joined set rows from repo.getSetsForMetrics (needs cycle_id and week_number).
 * @param cycle  A cycles row: { id, name, total_weeks, program }.
 * @param opts   { previousCycle } — a cycles row to draw as the comparison line.
 * @returns the snapshot, or null when there is no cycle to describe.
 */
function computeCycleSnapshot(rows, cycle, opts = {}) {
    if (!cycle || cycle.id === undefined || cycle.id === null) return null;

    const list = Array.isArray(rows) ? rows : [];
    const snap = build(list, cycle);

    snap.previous = null;
    const prev = opts.previousCycle;
    if (prev && prev.id !== undefined && Number(prev.id) !== Number(cycle.id)) {
        const p = build(list, prev);
        if (p.summary.strengthPct !== null) {
            snap.previous = {
                cycleId: p.cycleId, name: p.name, totalWeeks: p.totalWeeks,
                strengthPct: p.summary.strengthPct, byWeek: p.summary.byWeek
            };
        }
    }
    return snap;
}

module.exports = { computeCycleSnapshot };
