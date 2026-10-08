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
// A lift trained on two days (a heavy day and a volume day) is compared SLOT BY SLOT: this
// week's Day 1 against last week's Day 1. Adding both days into one total made a half-finished
// week look like a slip, because it was being weighed against a full one. A day that has not
// happened yet is simply not compared.
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

// Which day of the programme a session belongs to. Prefers the day's index, then its name; a
// session with neither falls into one shared slot, which behaves like the old whole-week total.
function slotKey(r) {
    if (r.day_index !== null && r.day_index !== undefined && r.day_index !== '') return 'd' + r.day_index;
    const name = String(r.day_name || '').trim().toLowerCase();
    return name ? 'n:' + name : 'x';
}

// One verdict for the week from the slot-by-slot comparisons. Any day that got heavier or gained
// reps is progress; a day that slipped only counts when nothing else moved.
function combine(comps) {
    const loads = comps.filter(c => c.kind === 'load');
    if (loads.length) return { kind: 'load', amount: Math.max(...loads.map(c => c.amount)) };
    const reps = comps.filter(c => c.kind === 'reps');
    if (reps.length) return { kind: 'reps', amount: reps.reduce((t, c) => t + c.amount, 0) };
    const downs = comps.filter(c => c.kind === 'down');
    if (downs.length) return downs.reduce((w, c) => (Math.abs(c.amount) > Math.abs(w.amount) ? c : w));
    return { kind: 'hold', amount: 0 };
}

// The sets that represent each day this week. If the same day was logged more than once (a repeat
// or a duplicated upload), the BEST single session stands for it, so doubled-up sets cannot inflate
// the comparison. Sessions with no day information cannot be told apart, so those are added together.
function slotSets(sessions) {
    const bySlot = new Map();
    for (const s of (sessions ? sessions.values() : [])) {
        if (!bySlot.has(s.slot)) bySlot.set(s.slot, []);
        bySlot.get(s.slot).push(s);
    }
    const out = new Map();
    const total = s => s.sets.reduce((t, x) => t + x.reps, 0);
    for (const [slot, list] of bySlot) {
        if (slot === 'x') { out.set(slot, list.flatMap(s => s.sets)); continue; }
        const best = list.reduce((b, s) =>
            (total(s) > total(b) || (total(s) === total(b) && new Date(s.date) >= new Date(b.date))) ? s : b);
        out.set(slot, best.sets);
    }
    return out;
}

function sessionList(sessions) {
    return Array.from(sessions ? sessions.values() : [])
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(s => ({
            workoutId: s.workoutId,
            dayName: s.dayName,
            date: s.date,
            sets: s.sets.map(x => ({ weight: x.weight === null ? null : round1(x.weight), reps: x.reps }))
        }));
}

// The order lifts appear in the programme: Day 1 top to bottom, then Day 2, and so on.
function programOrder(program) {
    const out = new Map();
    let i = 0;
    for (const d of (program && Array.isArray(program.days) ? program.days : [])) {
        for (const e of (Array.isArray(d.exercises) ? d.exercises : [])) {
            if (!e || !e.name) continue;
            const k = canonicalName(e.name);
            if (!out.has(k)) out.set(k, i);
            i++;
        }
    }
    return out;
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

// Logged work that belongs to no week of this cycle: a session saved while there was no active
// cycle, or one with no week number. It cannot be drawn on the scorecard, but it must never be
// invisible, so it is reported and the lifter can attach it to a week. Only work since this
// cycle began counts; older history from before cycles existed is not "missing".
function unplacedWork(list, cycle) {
    const since = cycle.created_at ? new Date(cycle.created_at).getTime() : -Infinity;
    const loose = new Map();
    for (const r of list) {
        const noCycle = r.cycle_id === null || r.cycle_id === undefined;
        const noWeek = Number(r.cycle_id) === Number(cycle.id) && !(Number(r.week_number) >= 1);
        if (!noCycle && !noWeek) continue;
        if (new Date(r.finished_at).getTime() < since) continue;
        const key = canonicalName(r.exercise_name) || String(r.exercise_name || '').toLowerCase();
        if (!loose.has(key)) loose.set(key, { name: r.exercise_name, sets: 0, sessions: new Set() });
        const x = loose.get(key);
        x.name = r.exercise_name;
        x.sets++;
        x.sessions.add(r.workout_id);
    }
    return Array.from(loose.values()).map(x => ({ name: x.name, sets: x.sets, sessions: x.sessions.size }));
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
        if (!lifts.has(key)) lifts.set(key, { key, name: r.exercise_name, weeks: new Map(), sessions: new Map() });
        const l = lifts.get(key);
        l.name = r.exercise_name;
        const w = Number(r.week_number);
        if (!l.weeks.has(w)) l.weeks.set(w, []);
        const set = { weight: toPounds(r), reps };
        l.weeks.get(w).push(set);

        if (!l.sessions.has(w)) l.sessions.set(w, new Map());
        const bySession = l.sessions.get(w);
        if (!bySession.has(r.workout_id)) {
            bySession.set(r.workout_id, { workoutId: r.workout_id, slot: slotKey(r), dayName: r.day_name || null, date: r.finished_at, sets: [] });
        }
        bySession.get(r.workout_id).sets.push(set);
    }

    const movements = [];
    for (const l of lifts.values()) {
        const role = roles.get(l.key) || null;
        const override = overrides[l.key] === 'progress' || overrides[l.key] === 'consistency' ? overrides[l.key] : null;
        const mode = override || (role ? trackingModeFor(role) : 'progress');

        const weeks = Array(totalWeeks).fill(null);
        let prev = null;                      // last logged NON-deload week: what the next week is compared with
        const lastBySlot = new Map();         // each day's most recent working session
        let moved = 0, possible = 0;
        const recent = [];
        for (let w = 1; w <= totalWeeks; w++) {
            if (!l.weeks.has(w)) continue;
            const s = summariseWeek(w, l.weeks.get(w));
            s.deload = isDeload(w);
            s.sessions = sessionList(l.sessions.get(w));
            // The reps in the week's single best session. Adding every session together made a week
            // with a repeated or duplicated day look better than it was, and made the next, shorter
            // week look like a collapse.
            s.bestSessionReps = s.sessions.length
                ? Math.max(...s.sessions.map(x => x.sets.reduce((t, y) => t + y.reps, 0)))
                : s.reps;
            if (mode === 'consistency') {
                s.delta = { kind: 'done' };
            } else {
                const comps = [];
                for (const [slot, sets] of slotSets(l.sessions.get(w))) {
                    const cur = summariseWeek(w, sets);
                    const before = lastBySlot.get(slot);
                    if (before) comps.push(compare(before, cur));
                    if (!s.deload) lastBySlot.set(slot, cur);
                }
                // No day to compare with (a first week, or the programme's days were renamed):
                // fall back to the whole-week comparison rather than guessing.
                s.delta = comps.length ? combine(comps) : compare(prev, s);
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
            // Change in reps per session between the first and latest working week: how a
            // bodyweight lift, which has no strength percentage, is summarised.
            repsChange: basis.length >= 2 ? latest.bestSessionReps - first.bestSessionReps : null,
            weeksMoved: moved,
            weeksCompared: possible,
            weeksDone: mode === 'consistency' ? logged.length : null,
            // Every set at the top of the target range: the double-progression trigger.
            readyForMore: mode === 'progress' && !!(range && latest.sets.length && latest.sets.every(s => s.reps >= range.max)),
            // Needs three comparisons of history before it is fair to call a lift stalled.
            stalling: mode === 'progress' && recent.length >= 3 && recent.slice(-3).filter(Boolean).length <= 1,
            _first: first,
            _key: l.key
        });
    }

    // Programme order, not first-logged order: a lift first done in week 2 should sit where the
    // plan puts it, not below every lift from week 1 where it is easy to miss.
    const order = programOrder(cycle.program);
    movements.forEach((m, i) => { m._i = i; });
    movements.sort((a, b) => (order.has(a._key) ? order.get(a._key) : 1e6 + a._i) - (order.has(b._key) ? order.get(b._key) : 1e6 + b._i));

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
        unplaced: unplacedWork(list, cycle),
        movements: movements.map(({ _first, _key, _i, ...m }) => m)
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
