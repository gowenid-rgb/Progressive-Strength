/*
 * Cycle snapshot — the data behind the Metrics scorecard.
 *
 * computeCycleSnapshot is a pure function, so these tests feed it rows directly. The cases
 * that matter are the ones a real cycle produces and a tidy fixture does not: cycles of
 * 4 and 12 weeks, a missed week, a lift added late, bodyweight work, and the case where a
 * heavier week LOWERS volume but is still progress.
 */
process.env.JWT_SECRET = 'snapshot-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

const path = require('path');
const http = require('http');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

const sets = (cycleId, week, name, weight, repsList, extra) => repsList.map((reps, i) => Object.assign({
    workout_id: cycleId * 1000 + week, finished_at: `2026-09-${String(week).padStart(2, '0')}T10:00:00Z`,
    cycle_id: cycleId, week_number: week, exercise_name: name,
    weight_value: weight, weight_unit: 'lb', is_bodyweight: weight === null, reps_value: reps, swapped_from: null
}, extra || {}));

const cycle = (id, weeks, program) => ({ id, name: 'Test cycle', total_weeks: weeks, program: program || null });

let PORT = null;
function req(method, p, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let d = ''; res.on('data', c => { d += c; });
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject); if (payload) r.write(payload); r.end();
    });
}

(async () => {
    const pg = installPgShim();
    const { computeCycleSnapshot } = require(path.join(ROOT, 'cycleSnapshot.js'));

    console.log('\n=== nothing to describe ===\n');
    check('no cycle gives null', computeCycleSnapshot([], null), null);
    check('null rows do not throw', computeCycleSnapshot(null, cycle(1, 6)).movements, []);
    let s = computeCycleSnapshot([], cycle(1, 6));
    check('an empty cycle still lists every week', s.phases.length, 6);
    check('an empty cycle has no headline number', s.summary.strengthPct, null);
    check('an empty cycle has no logged weeks', s.loggedThrough, 0);

    console.log('\n=== one logged week is not a change ===\n');
    s = computeCycleSnapshot(sets(1, 1, 'Bench Press', 135, [8, 7, 6]), cycle(1, 6));
    check('lift appears', s.movements.length, 1);
    check('first week is the baseline', s.movements[0].weeks[0].delta.kind, 'start');
    check('a single week is not tracked', s.movements[0].tracked, false);
    check('so the cycle has no headline yet', s.summary.strengthPct, null);
    check('and counts no lifts', s.summary.liftsTracked, 0);

    console.log('\n=== how a week is classified ===\n');
    const bench = [
        ...sets(1, 1, 'Bench Press', 135, [8, 7, 6, 6]),
        ...sets(1, 2, 'Bench Press', 135, [8, 8, 7, 6]),     // +2 reps
        ...sets(1, 3, 'Bench Press', 135, [8, 8, 7, 6]),     // identical
        ...sets(1, 4, 'Bench Press', 140, [6, 6, 6, 5]),     // heavier, fewer reps
        ...sets(1, 5, 'Bench Press', 140, [6, 5, 5, 5])      // same weight, fewer reps
    ];
    s = computeCycleSnapshot(bench, cycle(1, 6));
    const kinds = s.movements[0].weeks.map(w => w && w.delta.kind);
    check('baseline, reps, hold, load, slipped, then the unlogged week', kinds, ['start', 'reps', 'hold', 'load', 'down', null]);
    check('reps gained is exact', s.movements[0].weeks[1].delta.amount, 2);
    check('load gained is exact', s.movements[0].weeks[3].delta.amount, 5);
    check('lost reps are negative', s.movements[0].weeks[4].delta.amount, -2);
    check('a heavier week with LOWER volume is still progress',
        s.movements[0].weeks[3].volume < s.movements[0].weeks[2].volume && s.movements[0].weeks[3].delta.kind === 'load', true);

    console.log('\n=== one extra rep, anywhere, is progress ===\n');
    s = computeCycleSnapshot([...sets(1, 1, 'Row', 100, [10, 10, 10]), ...sets(1, 2, 'Row', 100, [10, 10, 11])], cycle(1, 4));
    check('a single extra rep on one set counts', s.movements[0].weeks[1].delta, { kind: 'reps', amount: 1 });
    s = computeCycleSnapshot([...sets(1, 1, 'Row', 100, [10, 10, 10]), ...sets(1, 2, 'Row', 100, [10, 10, 10]).map((r, i) => i === 2 ? { ...r, weight_value: 105 } : r)], cycle(1, 4));
    check('one set going up in weight counts', s.movements[0].weeks[1].delta, { kind: 'load', amount: 5 });

    console.log('\n=== the headline number ===\n');
    // Bench: 135x8 -> 140x6. e1RM 171 -> 168: slightly DOWN even though the weight rose,
    // because six reps at 140 is less than eight at 135. Honest, and worth showing.
    s = computeCycleSnapshot([...sets(1, 1, 'Bench', 135, [8]), ...sets(1, 2, 'Bench', 140, [6])], cycle(1, 4));
    check('e1RM at baseline', s.movements[0].weeks[0].e1rm, 171);
    check('e1RM later', s.movements[0].weeks[1].e1rm, 168);
    check('percent change', s.movements[0].changePct, -1.8);

    // Two lifts averaged equally, whatever their absolute weights.
    s = computeCycleSnapshot([
        ...sets(1, 1, 'Squat', 200, [5]), ...sets(1, 2, 'Squat', 220, [5]),     // +10%
        ...sets(1, 1, 'Curl', 20, [10]), ...sets(1, 2, 'Curl', 20, [10])        // 0%
    ], cycle(1, 4));
    check('lifts are averaged equally', s.summary.strengthPct, 5);
    check('lifts up', [s.summary.liftsUp, s.summary.liftsTracked], [1, 2]);

    // The split is exact: weight part + reps part == total.
    s = computeCycleSnapshot([...sets(1, 1, 'Bench', 135, [8]), ...sets(1, 3, 'Bench', 145, [6])], cycle(1, 6));
    const m0 = s.movements[0];
    check('weight and rep contributions add up to the total (to rounding)', Math.abs(m0.fromWeightPct + m0.fromRepsPct - m0.changePct) <= 0.1, true);
    check('heavier-for-fewer-reps shows a negative reps part', m0.fromRepsPct < 0 && m0.fromWeightPct > 0, true);

    console.log('\n=== gaps, late starts, bodyweight ===\n');
    s = computeCycleSnapshot([
        ...sets(1, 1, 'Deadlift', 225, [5]), ...sets(1, 2, 'Deadlift', 225, [5]),
        /* week 3 missed */ ...sets(1, 4, 'Deadlift', 235, [5])
    ], cycle(1, 8));
    const dl = s.movements[0];
    check('a missed week is null, not zero', dl.weeks.map(w => w && w.week), [1, 2, null, 4, null, null, null, null]);
    check('week 4 is compared with week 2, the last logged week', dl.weeks[3].delta, { kind: 'load', amount: 10 });
    check('only logged comparisons are counted', [dl.weeksMoved, dl.weeksCompared], [1, 2]);

    // A lift introduced in week 3 is measured from week 3, not from a week it never had.
    s = computeCycleSnapshot([
        ...sets(1, 1, 'Squat', 200, [5]), ...sets(1, 4, 'Squat', 210, [5]),
        ...sets(1, 3, 'Lunge', 100, [8]), ...sets(1, 4, 'Lunge', 100, [8])
    ], cycle(1, 6));
    const lunge = s.movements.find(m => m.name === 'Lunge');
    check('late lift baselines at its own first week', lunge.baselineWeek, 3);
    check('its change is measured from there', lunge.changePct, 0);
    check('week 2 of the cycle number ignores the lift that had not started', s.summary.byWeek[1], null);
    check('week 3 has only the lift that existed', s.summary.byWeek[2], 0);

    // Bodyweight: progress is reps, and it never poisons the strength number.
    s = computeCycleSnapshot([
        ...sets(1, 1, 'Pull Ups', null, [8, 7, 6]), ...sets(1, 2, 'Pull Ups', null, [9, 8, 6]),
        ...sets(1, 1, 'Bench', 135, [8]), ...sets(1, 2, 'Bench', 135, [8])
    ], cycle(1, 4));
    const pu = s.movements.find(m => m.name === 'Pull Ups');
    check('bodyweight progress is read from reps', pu.weeks[1].delta, { kind: 'reps', amount: 2 });
    check('bodyweight has no strength percent', pu.changePct, null);
    check('and is left out of the headline', [s.summary.liftsTracked, s.summary.strengthPct], [1, 0]);
    check('but still counts toward weeks won', s.summary.weeksWon, 1);

    console.log('\n=== cycle length: 4 to 12 weeks (and beyond) ===\n');
    for (const n of [4, 6, 8, 12, 16]) {
        const rows = [];
        for (let w = 1; w <= n - 1; w++) rows.push(...sets(1, w, 'Squat', 185 + w * 5, [8, 7, 6]));
        s = computeCycleSnapshot(rows, cycle(1, n));
        check(`${n}-week cycle: one slot per week`, s.movements[0].weeks.length, n);
        check(`${n}-week cycle: one phase per week`, s.phases.length, n);
        check(`${n}-week cycle: last week is the deload`, s.phases[n - 1].key, 'deload');
        check(`${n}-week cycle: cycle line has a slot per week`, s.summary.byWeek.length, n);
        check(`${n}-week cycle: unlogged deload is null`, s.summary.byWeek[n - 1], null);
        check(`${n}-week cycle: logged through the week before the deload`, s.loggedThrough, n - 1);
    }
    // total_weeks shortened after sessions were logged: keep the data.
    s = computeCycleSnapshot(sets(1, 7, 'Squat', 200, [5]), cycle(1, 4));
    check('data past a shortened cycle is kept, not dropped', s.totalWeeks, 7);

    console.log('\n=== the signals on a lift ===\n');
    const prog = { days: [{ exercises: [{ name: 'Bench Press', repRange: '6-8' }] }], weeks: [] };
    s = computeCycleSnapshot([...sets(1, 1, 'Bench Press', 135, [8, 7, 7]), ...sets(1, 2, 'Bench Press', 135, [8, 8, 8])], cycle(1, 6, prog));
    check('rep range is read from the programme', s.movements[0].range, { min: 6, max: 8 });
    check('every set at the ceiling means add weight', s.movements[0].readyForMore, true);
    s = computeCycleSnapshot([...sets(1, 1, 'Bench Press', 135, [8, 7, 7]), ...sets(1, 2, 'Bench Press', 135, [8, 8, 7])], cycle(1, 6, prog));
    check('one set short of the ceiling is not ready', s.movements[0].readyForMore, false);
    check('no range, no "ready"', computeCycleSnapshot(sets(1, 1, 'Bench', 135, [8, 8]), cycle(1, 6)).movements[0].readyForMore, false);

    const flat = [1, 2, 3, 4, 5].flatMap(w => sets(1, w, 'OHP', 85, [8, 8, 8]));
    s = computeCycleSnapshot(flat, cycle(1, 6));
    check('three flat weeks in a row is stalling', s.movements[0].stalling, true);
    s = computeCycleSnapshot([...sets(1, 1, 'OHP', 85, [8]), ...sets(1, 2, 'OHP', 85, [8])], cycle(1, 6));
    check('two weeks is too little history to call a stall', s.movements[0].stalling, false);

    console.log('\n=== names and phases ===\n');
    s = computeCycleSnapshot([...sets(1, 1, 'Barbell Bench Press', 135, [8]), ...sets(1, 2, 'Bench Press (Barbell)', 140, [8])], cycle(1, 6));
    check('a drifted name is one lift, not two', s.movements.length, 1);
    check('displayed under the newest spelling', s.movements[0].name, 'Bench Press (Barbell)');
    s = computeCycleSnapshot([], cycle(1, 6, { weeks: [{ week: 1, phase: 'peak' }] }));
    check('a programme\'s own phase wins', s.phases[0].key, 'peak');
    check('missing weeks fall back to the default phases', s.phases[5].key, 'deload');

    console.log('\n=== last cycle, for the comparison line ===\n');
    const both = [
        ...sets(1, 1, 'Squat', 180, [5]), ...sets(1, 2, 'Squat', 185, [5]), ...sets(1, 3, 'Squat', 190, [5]),
        ...sets(2, 1, 'Squat', 200, [5]), ...sets(2, 2, 'Squat', 210, [5])
    ];
    s = computeCycleSnapshot(both, cycle(2, 6), { previousCycle: cycle(1, 4) });
    check('previous cycle is summarised', [s.previous.cycleId, s.previous.totalWeeks], [1, 4]);
    check('with its own week-by-week line', s.previous.byWeek.length, 4);
    check('and its own result', s.previous.strengthPct > 0, true);
    check('rows from the other cycle do not leak in', s.movements[0].weeks[2], null);
    check('no previous cycle means null', computeCycleSnapshot(both, cycle(2, 6)).previous, null);
    check('a previous cycle with no history means null', computeCycleSnapshot(both, cycle(2, 6), { previousCycle: cycle(9, 6) }).previous, null);
    check('a cycle is never its own comparison', computeCycleSnapshot(both, cycle(2, 6), { previousCycle: cycle(2, 6) }).previous, null);

    console.log('\n=== roles ===\n');
    const prog5 = require(path.join(ROOT, 'program.js'));
    check('known roles pass through', prog5.ROLES.map(prog5.normaliseRole), prog5.ROLES);
    check('free-text warm-up variants map to warmup', ['Warm-up', 'warm up', 'Mobility', 'activation', 'Prehab'].map(prog5.normaliseRole), Array(5).fill('warmup'));
    check('old "primary" role maps to main', prog5.normaliseRole('primary'), 'main');
    check('cardio and finishers are conditioning', ['Cardio', 'finisher', 'HIIT'].map(prog5.normaliseRole), Array(3).fill('conditioning'));
    check('core and abs are core', ['Core', 'abs'].map(prog5.normaliseRole), ['core', 'core']);
    check('anything unknown is an accessory, tracked', [prog5.normaliseRole('???'), prog5.normaliseRole(null)], ['accessory', 'accessory']);
    check('warm-ups and conditioning are not judged on progress', ['warmup', 'conditioning'].map(prog5.trackingModeFor), ['consistency', 'consistency']);
    check('main, accessory and core are', ['main', 'accessory', 'core'].map(prog5.trackingModeFor), Array(3).fill('progress'));
    const messy = { days: [{ exercises: [{ name: 'A', role: 'Warm-up' }, { name: 'B', role: 'primary' }, { name: 'C' }] }] };
    check('stored programmes get a clean role on every exercise', prog5.normaliseRoles(messy).days[0].exercises.map(e => e.role), ['warmup', 'main', 'accessory']);
    check('the model is constrained to the role list', prog5.PROGRAM_SCHEMA.properties.days.items.properties.exercises.items.properties.role.enum, prog5.ROLES);

    console.log('\n=== warm-ups are not judged on progress ===\n');
    const wprog = { days: [{ exercises: [
        { name: 'Cat-Cow', role: 'warmup', repRange: '10' },
        { name: 'Bench Press', role: 'main', repRange: '6-8' }] }], weeks: [] };
    const wrows = [1, 2, 3, 4, 5].flatMap(w => [
        ...sets(1, w, 'Cat-Cow', null, [10]),                   // identical every week
        ...sets(1, w, 'Bench Press', 135 + w * 5, [8, 7, 6])]);
    s = computeCycleSnapshot(wrows, cycle(1, 6, wprog));
    const cat = s.movements.find(m => m.name === 'Cat-Cow'), benchW = s.movements.find(m => m.name === 'Bench Press');
    check('a warm-up is in consistency mode', [cat.mode, cat.role, cat.modeSource], ['consistency', 'warmup', 'role']);
    check('so it is never "stalling" despite five identical weeks', cat.stalling, false);
    check('it has no arrows to show', cat.weeks.filter(Boolean).map(w => w.delta.kind), Array(5).fill('done'));
    check('no strength change is invented for it', cat.changePct, null);
    check('it records that it was done', cat.weeksDone, 5);
    check('the lift next to it is still judged', benchW.mode, 'progress');
    check('the headline counts only the judged lift', s.summary.liftsTracked, 1);
    check('weeks won ignores the warm-up', [s.summary.weeksWon, s.summary.weeksCompared], [4, 4]);
    check('warm-up completion is reported separately', s.summary.untracked, { movements: 1, weeksDone: 5, weeksPossible: 5 });

    // A missed warm-up week is visible in the completion count.
    s = computeCycleSnapshot(wrows.filter(r => !(r.exercise_name === 'Cat-Cow' && r.week_number === 3)), cycle(1, 6, wprog));
    check('a skipped warm-up week lowers completion', s.summary.untracked, { movements: 1, weeksDone: 4, weeksPossible: 5 });

    console.log('\n=== the lifter can override the mode ===\n');
    const key = require(path.join(ROOT, 'metrics.js')).canonicalName;
    s = computeCycleSnapshot(wrows, { ...cycle(1, 6, wprog), tracking_overrides: { [key('Bench Press')]: 'consistency' } });
    check('a lift can be switched off', s.movements.find(m => m.name === 'Bench Press').mode, 'consistency');
    check('and says why', s.movements.find(m => m.name === 'Bench Press').modeSource, 'override');
    check('leaving nothing to judge', s.summary.strengthPct, null);
    s = computeCycleSnapshot(wrows, { ...cycle(1, 6, wprog), tracking_overrides: { [key('Cat-Cow')]: 'progress' } });
    check('a warm-up can be switched on', s.movements.find(m => m.name === 'Cat-Cow').mode, 'progress');
    s = computeCycleSnapshot(wrows, { ...cycle(1, 6, wprog), tracking_overrides: { [key('Bench Press')]: 'nonsense' } });
    check('an invalid override is ignored, not trusted', s.movements.find(m => m.name === 'Bench Press').mode, 'progress');
    s = computeCycleSnapshot(wrows, cycle(1, 6));
    check('a cycle with no programme judges everything', s.movements.map(m => m.mode), ['progress', 'progress']);

    console.log('\n=== deload weeks ===\n');
    // 6-week cycle: week 6 is the deload. Weeks 1-5 build, week 6 drops the load.
    const dload = [
        ...sets(1, 1, 'Squat', 185, [8, 7, 6]), ...sets(1, 2, 'Squat', 185, [8, 8, 7]), ...sets(1, 3, 'Squat', 190, [7, 6, 6]),
        ...sets(1, 4, 'Squat', 190, [8, 7, 6]), ...sets(1, 5, 'Squat', 195, [7, 6, 6]),
        ...sets(1, 6, 'Squat', 155, [8, 8])                    // deload: lighter, fewer sets
    ];
    s = computeCycleSnapshot(dload, cycle(1, 6));
    const sq = s.movements[0];
    check('the deload week is logged and shown', sq.weeks[5] !== null && sq.weeks[5].week === 6, true);
    check('and flagged as a deload', [sq.weeks[4].deload, sq.weeks[5].deload], [false, true]);
    check('the phase list agrees', s.phases[5].key, 'deload');
    check('a lighter deload week is NOT counted against the lift', sq.weeksCompared, 4);
    check('only working weeks are counted as won or not', sq.weeksMoved, 4);
    check('the deload still compares with the last working week, for display', sq.weeks[5].delta.kind, 'down');
    check('latest logged week is the deload', sq.latestWeek, 6);
    check('but the headline uses the last working week, so the cycle does not "lose" strength', sq.changePct > 0, true);
    check('the deload shows on the cycle line', s.summary.byWeek[5] !== null, true);
    check('and it dips there', s.summary.byWeek[5] < s.summary.byWeek[4], true);
    check('logged through the deload', s.loggedThrough, 6);

    // The week AFTER a deload is compared with the week before it.
    const after = computeCycleSnapshot([
        ...sets(1, 1, 'Squat', 185, [8, 8]), ...sets(1, 2, 'Squat', 155, [6, 6]), ...sets(1, 3, 'Squat', 195, [6, 6])
    ], cycle(1, 3, { weeks: [{ week: 1, phase: 'base' }, { week: 2, phase: 'deload' }, { week: 3, phase: 'build' }] }));
    check('week after a deload compares with the week before it', after.movements[0].weeks[2].delta, { kind: 'load', amount: 10 });
    check('and the deload itself is flagged', after.movements[0].weeks[1].deload, true);

    // A fully logged ordinary week is unaffected.
    check('non-deload weeks are not flagged', computeCycleSnapshot(sets(1, 1, 'Squat', 185, [8]), cycle(1, 6)).movements[0].weeks[0].deload, false);

    console.log('\n=== through the API, against real Postgres ===\n');

    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => {
                PORT = this.address().port;
                if (typeof cb === 'function') cb();
                resolve();
            });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;
    const db = require(path.join(ROOT, 'db.js'));
    await require(path.join(ROOT, 'migrate.js')).migrate(db);

    const reg = await req('POST', '/api/auth/register', { email: 'snap@example.com', password: 'password1234' });
    const token = reg.body.token;
    let r = await req('GET', '/api/metrics', undefined, token);
    check('no cycle means cycle is null, not an error', [r.status, r.body.cycle], [200, null]);
    check('the existing fields are untouched', r.body.counts.allTime, 0);

    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Bench Press', sets: 3, reps: '8' }] }] },
        cycleOptions: { totalWeeks: 6 }
    }, token);
    const log = (week, weight, reps) => req('POST', '/api/workouts', {
        dayName: 'Push', durationSeconds: 3000, weekNumber: week,
        exercises: [{ name: 'Bench Press', sets: reps.map((x, i) => ({ set: i + 1, weight: String(weight), reps: String(x) })) }]
    }, token);
    await log(1, 135, [8, 7, 6]);
    await log(2, 135, [8, 8, 7]);
    await log(3, 140, [6, 6, 6]);

    r = await req('GET', '/api/metrics', undefined, token);
    const c = r.body.cycle;
    check('the active cycle comes back', !!c, true);
    check('with its real length', c.totalWeeks, 6);
    check('one lift', c.movements.length, 1);
    check('three logged weeks', c.loggedThrough, 3);
    check('classified from real rows', c.movements[0].weeks.map(w => w && w.delta.kind), ['start', 'reps', 'load', null, null, null]);
    check('a headline number exists', typeof c.summary.strengthPct, 'number');
    check('no previous cycle yet', c.previous, null);
    check('existing metrics fields still present', r.body.counts.allTime, 3);

    console.log('\n=== the tracking override endpoint ===\n');
    let tr = await req('POST', '/api/cycle/tracking', { name: 'Bench Press', mode: 'consistency' });
    check('requires auth', tr.status, 401);
    tr = await req('POST', '/api/cycle/tracking', { name: '', mode: 'consistency' }, token);
    check('a name is required', tr.status, 400);
    tr = await req('POST', '/api/cycle/tracking', { name: 'Bench Press', mode: 'banana' }, token);
    check('an unknown mode is rejected', tr.status, 400);
    tr = await req('POST', '/api/cycle/tracking', { name: 'Bench Press', mode: 'consistency' }, token);
    check('switching a lift off is accepted', tr.status, 200);
    r = await req('GET', '/api/metrics', undefined, token);
    check('the snapshot reflects it', r.body.cycle.movements[0].mode, 'consistency');
    check('and says it was the lifter\'s choice', r.body.cycle.movements[0].modeSource, 'override');
    tr = await req('POST', '/api/cycle/tracking', { name: 'Press, Bench', mode: null }, token);
    check('clearing works, even under a re-spelled name', tr.body.trackingOverrides, {});
    r = await req('GET', '/api/metrics', undefined, token);
    check('and the lift is judged again', r.body.cycle.movements[0].mode, 'progress');

    const other = await req('POST', '/api/auth/register', { email: 'snap2@example.com', password: 'password1234' });
    r = await req('GET', '/api/metrics', undefined, other.body.token);
    check('a second user sees none of it', r.body.cycle, null);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
