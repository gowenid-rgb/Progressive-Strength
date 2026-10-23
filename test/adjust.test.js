/*
 * "Adjust program": what it may and may not touch.
 *
 * The model rewrites the current week from a sentence of feedback. These tests prove that
 * logged sessions and metrics are untouched, movement names stay as spelled, completed days
 * survive, and a "from now on" set change reaches every later week.
 */
process.env.JWT_SECRET = 'adjust-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_PROVIDER = 'claude';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

const path = require('path');
const http = require('http');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const { stubAI } = require('./helpers/aistub');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();
const adjust = require(path.join(ROOT, 'adjust.js'));

let PORT = null;
function req(method, p, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

const PROGRAM = {
    programName: 'Strength Base', rationale: 'x', totalWeeks: 4,
    progression: { rule: 'Add weight when every set hits the top.', incrementUpper: 5, incrementLower: 10 },
    days: [
        { dayName: 'Pull', exercises: [
            { name: '90/90 Hip Flow', role: 'warmup', repRange: '8', baseSets: 1 },
            { name: 'Barbell Deadlift', role: 'main', repRange: '5', baseSets: 5 },
            { name: 'Barbell Row', role: 'accessory', repRange: '8-10', baseSets: 3 }
        ] },
        { dayName: 'Push', exercises: [
            { name: 'Barbell Bench Press', role: 'main', repRange: '6-8', baseSets: 3 }
        ] }
    ],
    weeks: [1, 2, 3, 4].map(w => ({ week: w, phase: w === 4 ? 'deload' : 'base', intent: 'x', setAdjustment: 0 }))
};

const plan = (days) => ({ planName: 'Strength Base', week: 1, totalWeeks: 4, phase: 'base', days });
const ex = (name, sets, reps) => ({ name, sets, reps: reps || '5' });

(async () => {
    installPgShim();

    console.log('\n=== keeping the lifter spelling ===\n');
    const anchors = ['Barbell Deadlift', 'Barbell Bench Press', 'Romanian Deadlift', 'Dumbbell Row'];
    check('"Deadlift" snaps back to "Barbell Deadlift"', adjust.anchorFor('Deadlift', anchors, ''), 'Barbell Deadlift');
    check('word order and punctuation snap back', adjust.anchorFor('Bench Press (Barbell)', anchors, ''), 'Barbell Bench Press');
    check('an exact name is left alone', adjust.anchorFor('barbell deadlift', anchors, ''), null);
    check('a different lift is left alone', adjust.anchorFor('Sumo Deadlift', anchors, ''), null);
    check('swapping the implement is a different lift', adjust.anchorFor('Dumbbell Bench Press', anchors, ''), null);
    check('"Row" does not guess between two lifts', adjust.anchorFor('Row', ['Barbell Row', 'Dumbbell Row'], ''), null);
    check('a deliberate implement change stands',
        adjust.anchorFor('Dumbbell Deadlift', ['Deadlift'], 'use dumbbells for deadlift'), null);

    const snapped = adjust.snapNames(plan([{ dayName: 'A', exercises: [ex('Deadlift', 4), ex('Bench Press (Barbell)', 3)] }]), anchors, 'fewer sets');
    check('names are rewritten in the plan', snapped.plan.days[0].exercises.map(e => e.name), ['Barbell Deadlift', 'Barbell Bench Press']);
    check('and reported', snapped.renamed.length, 2);

    console.log('\n=== completed days are history ===\n');
    const old = plan([
        { dayName: 'Pull', completed: true, exercises: [ex('Barbell Deadlift', 5)] },
        { dayName: 'Push', exercises: [ex('Barbell Bench Press', 3)] }
    ]);
    const rewritten = plan([
        { dayName: 'Pull', exercises: [ex('Deadlift', 2)] },
        { dayName: 'Push', exercises: [ex('Barbell Bench Press', 4)] }
    ]);
    adjust.restoreCompletedDays(rewritten, old);
    check('a completed day comes back exactly as it was', [rewritten.days[0].exercises[0].name, rewritten.days[0].exercises[0].sets, rewritten.days[0].completed], ['Barbell Deadlift', 5, true]);
    check('an open day keeps the change', rewritten.days[1].exercises[0].sets, 4);
    const dropped = plan([{ dayName: 'Push', exercises: [ex('Barbell Bench Press', 4)] }]);
    adjust.restoreCompletedDays(dropped, old);
    check('a completed day the model dropped is put back, with the rest in order', dropped.days.map(d => d.dayName), ['Pull', 'Push']);

    console.log('\n=== set changes ===\n');
    check('detected on open days only', adjust.diffSets(old, rewritten), [{ dayIndex: 1, name: 'Barbell Bench Press', from: 3, to: 4 }]);
    check('"all future workouts" counts as lasting', adjust.wantsFuture('drop deadlift to 4 sets in all future workouts'), true);
    check('"from now on" counts', adjust.wantsFuture('from now on do 4 sets'), true);
    check('a one-off request does not', adjust.wantsFuture('my back is tight today, fewer sets'), false);
    check('"this week only" opts out of lasting changes', adjust.wantsThisWeekOnly('fewer sets, this week only'), true);
    check('an ordinary request does not opt out', adjust.wantsThisWeekOnly('drop deadlift to 4 sets'), false);
    const applied = adjust.applySetChangesToProgram(PROGRAM, [{ dayIndex: 0, name: 'Barbell Deadlift', from: 5, to: 4 }, { dayIndex: 0, name: '90/90 Hip Flow', from: 1, to: 3 }]);
    check('the programme takes the new count', applied.program.days[0].exercises[1].baseSets, 4);
    check('a warm-up never leaves one set', applied.program.days[0].exercises[0].baseSets, 1);
    check('the original programme object is untouched', PROGRAM.days[0].exercises[1].baseSets, 5);

    // A plan the app has not saved yet can be older than the programme. Only what this
    // adjustment changed is written, so an echo of the stale value cannot undo an earlier change.
    const stalePlan = plan([{ dayName: 'Pull', exercises: [ex('90/90 Hip Flow', 1, '8'), ex('Barbell Deadlift', 5), ex('Barbell Row', 3, '8-10')] }]);
    const echoed = plan([{ dayName: 'Pull', exercises: [ex('90/90 Hip Flow', 1, '8'), ex('Barbell Deadlift', 5), ex('Barbell Row', 2, '8-10')] }]);
    const programAt4 = JSON.parse(JSON.stringify(PROGRAM));
    programAt4.days[0].exercises[1].baseSets = 4;
    const staleResult = adjust.applyPlanToProgram(programAt4, stalePlan, echoed);
    check('an echoed stale value does not undo an earlier change', staleResult.program.days[0].exercises[1].baseSets, 4);
    check('while the real change still lands', staleResult.program.days[0].exercises[2].baseSets, 2);

    console.log('\n=== end to end: adjusting never touches logged data ===\n');
    const ai = require(path.join(ROOT, 'aiClient.js'));
    let nextAnswer = PROGRAM;
    stubAI(ai, async () => JSON.stringify(nextAnswer));

    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => { PORT = this.address().port; if (typeof cb === 'function') cb(); resolve(); });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;
    const db = require(path.join(ROOT, 'db.js'));
    await require(path.join(ROOT, 'migrate.js')).migrate(db);

    const reg = await req('POST', '/api/auth/register', { email: 'adjuster@example.com', password: 'password1234' });
    const token = reg.body.token;
    const made = await req('POST', '/api/generate-program', { primaryGoal: 'Strength', experienceLevel: 'Intermediate', totalWeeks: 4 }, token);
    check('programme created', made.status, 200);
    await req('POST', '/api/user/data', { currentPlan: made.body.plan }, token);

    await req('POST', '/api/workouts', {
        dayName: 'Pull', dayIndex: 0, weekNumber: 1, date: '2026-09-21T18:00:00.000Z', clientId: 'adj-1',
        exercises: [{ name: 'Barbell Deadlift', sets: [5, 5, 5, 5, 5].map((r, i) => ({ set: i + 1, weight: '225', reps: String(r) })) }]
    }, token);

    const snapshot = async () => ({
        workouts: (await db.query('SELECT id, day_name, week_number, finished_at FROM workouts ORDER BY id')).rows,
        sets: (await db.query('SELECT id, exercise_name, weight_value, reps_value, set_number FROM workout_sets ORDER BY id')).rows,
        // generatedAt is the moment of the request, not data.
        metrics: Object.assign({}, (await req('GET', '/api/metrics', undefined, token)).body, { generatedAt: null })
    });
    const before = await snapshot();
    check('a session is logged', before.sets.length, 5);

    // The model re-words the lift and (as asked) cuts the sets.
    const current = (await req('GET', '/api/user/data', undefined, token)).body.currentPlan;
    check('the plan starts at 5 sets of deadlift', current.days[0].exercises.find(e => /deadlift/i.test(e.name)).sets, 5);
    current.days[0].completed = true;
    await req('POST', '/api/user/data', { currentPlan: current }, token);

    nextAnswer = plan([
        { dayName: 'Pull', exercises: [ex('Deadlift', 4), ex('Barbell Row', 3)] },
        { dayName: 'Push', exercises: [ex('Bench Press (Barbell)', 3, '6-8')] }
    ]);
    const adj = await req('POST', '/api/recalibrate-plan', { currentPlan: current, feedback: 'we have 5 sets of deadlift, drop it to 4 in all future workouts' }, token);
    check('adjusting succeeds', adj.status, 200);
    check('the completed day is untouched', adj.body.days[0].exercises.find(e => /deadlift/i.test(e.name)).sets, 5);
    check('names stay as spelled', adj.body.days[1].exercises[0].name, 'Barbell Bench Press');
    check('it reports the renames', adj.body.adjustment.renamed.length >= 1, true);

    const after = await snapshot();
    check('no logged session changed', after.workouts, before.workouts);
    check('no logged set changed', after.sets, before.sets);
    check('metrics are identical', after.metrics, before.metrics);

    console.log('\n=== a change that lasts ===\n');
    nextAnswer = plan([
        { dayName: 'Pull', exercises: [ex('Barbell Deadlift', 4), ex('Barbell Row', 3)] },
        { dayName: 'Push', exercises: [ex('Barbell Bench Press', 5, '6-8')] }
    ]);
    const open = (await req('GET', '/api/user/data', undefined, token)).body.currentPlan;
    const adj2 = await req('POST', '/api/recalibrate-plan', { currentPlan: open, feedback: 'bench press should be 5 sets from now on' }, token);
    check('lasting change is applied to the programme', adj2.body.adjustment.appliedToFuture.map(c => [c.kind, c.name, c.to]), [['sets', 'Barbell Bench Press', 5]]);
    check('and the open day shows it now', adj2.body.days[1].exercises[0].sets, 5);

    const adv = await req('POST', '/api/cycle/advance', {}, token);
    check('next week is built with 5 sets of bench', adv.body.plan.days[1].exercises[0].sets, 5);
    check('and the other lifts are unchanged', adv.body.plan.days[0].exercises.find(e => e.name === 'Barbell Row').sets, 3);
    const after2 = await snapshot();
    check('logged data still identical after the lasting change', [after2.workouts, after2.sets], [before.workouts, before.sets]);

    // A one-off tweak must not rewrite later weeks.
    nextAnswer = plan([
        { dayName: 'Pull', exercises: [ex('Barbell Deadlift', 4), ex('Barbell Row', 2)] },
        { dayName: 'Push', exercises: [ex('Barbell Bench Press', 5, '6-8')] }
    ]);
    const wk2 = (await req('GET', '/api/user/data', undefined, token)).body.currentPlan;
    const adj3 = await req('POST', '/api/recalibrate-plan', { currentPlan: wk2, feedback: 'short on time, fewer sets of rows, this week only' }, token);
    check('an explicit one-off change is flagged as this week only', adj3.body.adjustment.thisWeekOnly, true);
    const adv2 = await req('POST', '/api/cycle/advance', {}, token);
    check('week 3 is not affected by a one-off change', adv2.body.plan.days[0].exercises.find(e => e.name === 'Barbell Row').sets, 3);

    console.log('\n=== adjusting is the default for the whole programme ===\n');
    // No wording about the future at all: a swap through Adjust still carries forward.
    nextAnswer = plan([
        { dayName: 'Pull', exercises: [ex('90/90 Hip Flow', 1, '8'), ex('Barbell Deadlift', 5), ex('Seated Cable Row', 3, '8-10')] },
        { dayName: 'Push', exercises: [ex('Barbell Bench Press', 5, '6-8')] }
    ]);
    const wk3 = (await req('GET', '/api/user/data', undefined, token)).body.currentPlan;
    const adj4 = await req('POST', '/api/recalibrate-plan', { currentPlan: wk3, feedback: 'my gym has no barbell row, use a cable row instead' }, token);
    check('a swap is applied to the programme by default', adj4.body.adjustment.appliedToFuture.map(c => [c.kind, c.from, c.to]), [['replaced', 'Barbell Row', 'Seated Cable Row']]);
    const adv3 = await req('POST', '/api/cycle/advance', {}, token);
    check('the swap is in the next week too', adv3.body.plan.days[0].exercises.map(e => e.name).includes('Seated Cable Row'), true);
    check('and the old lift is gone from it', adv3.body.plan.days[0].exercises.map(e => e.name).includes('Barbell Row'), false);
    const after3 = await snapshot();
    check('the logged data is still identical', [after3.workouts, after3.sets], [before.workouts, before.sets]);
    check('the old lift is still in the logged history', (await db.query("SELECT COUNT(*) AS n FROM workout_sets WHERE exercise_name = 'Barbell Deadlift'")).rows[0].n > 0, true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
