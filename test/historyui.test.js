/*
 * The "Logged workouts" screen, and saving a workout exactly once, as the browser runs them.
 *
 * The page's own script is loaded in a stubbed environment. What matters: a correction really
 * reaches the server in the right shape, the phone's own copy of history is brought into line
 * (or the old numbers would return), a failed change leaves the lifter somewhere they can retry,
 * nothing typed or logged can inject markup, and a workout can never be saved twice.
 */
process.env.JWT_SECRET = 'historyui-test-secret-long-enough-to-avoid-warnings';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();
const { computeCycleSnapshot } = require(path.join(ROOT, 'cycleSnapshot.js'));

function harness(fetchImpl, opts) {
    opts = opts || {};
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .sort((a, b) => b.length - a.length)[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
    const els = {};
    const el = id => els[id] || (els[id] = {
        innerHTML: '', innerText: '', textContent: '', value: '', className: '', dataset: {},
        classList: { add() {}, remove() {}, contains: () => false }, querySelector: () => null, scrollIntoView() {}
    });
    const store = new Map(Object.entries(opts.storage || {}));
    const calls = [], confirms = [], alerts = [];
    const ctx = {
        console, Date, JSON, Math, parseInt, Array, Object, String, Number, Set, Map, Promise,
        setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
        navigator: {}, window: { addEventListener() {} }, self: {},
        alert: m => alerts.push(m),
        confirm: m => { confirms.push(m); return ctx.__confirm !== false; },
        fetch: async (url, o) => { calls.push({ url, method: (o && o.method) || 'GET', body: o && o.body ? JSON.parse(o.body) : undefined }); return fetchImpl(url, o); },
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : (k === 'token' ? 'tok' : null)), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        document: {
            addEventListener() {}, getElementById: el, querySelector: () => null,
            querySelectorAll: sel => (String(sel).includes('.set-row') ? (opts.rows || []) : [])
        }
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(inline + `
        renderPlan = function () {};
        nav = function (s) { __nav.push(s); };
        maybeAdvanceWeek = async function () {};
        syncData = async function () {};
        globalThis.__state = function () { return { metricsCache, workoutClientId, finishingWorkout, historyEdit, historyBusy, historyError }; };
        globalThis.__arm = function (plan, dayIdx, started, clientId) { currentWorkoutPlan = plan; activeDayIndex = dayIdx; workoutStartTime = started; workoutClientId = clientId; };
        globalThis.__setMetrics = function (v) { metricsCache = v; };
    `, Object.assign(ctx, { __nav: [] }));
    return { ctx, calls, confirms, alerts, store, els, el, state: () => ctx.__state() };
}

const ok = body => ({ ok: true, json: async () => body });
const bad = (status, body) => ({ ok: false, status, json: async () => body || {} });

const set = (id, n, weight, reps, extra) => Object.assign({ id, set: n, weight, reps, isBodyweight: weight === 'BW', edited: false }, extra || {});
const WORKOUTS = {
    cycle: { id: 7, totalWeeks: 6, currentWeek: 2 },
    workouts: [
        { id: 1, cycleId: 7, weekNumber: 1, dayName: 'Day 1 - Squat Strength', date: '2026-09-21T18:00:00Z', possibleDuplicateOf: null,
          exercises: [{ name: 'Weighted Pull-Up', sets: [set(11, 1, '35', '6'), set(12, 2, '35', '5', { edited: true }), set(13, 3, 'BW', '8')] }] },
        { id: 2, cycleId: 7, weekNumber: 1, dayName: 'Day 1 - Squat Strength', date: '2026-09-21T18:00:00Z', possibleDuplicateOf: 1,
          exercises: [{ name: 'Weighted Pull-Up', sets: [set(21, 1, '35', '5')] }] },
        { id: 3, cycleId: 7, weekNumber: 2, dayName: 'Day 2 - Bench', date: '2026-09-28T18:00:00Z', possibleDuplicateOf: null,
          exercises: [{ name: 'Flat Dumbbell Bench Press', sets: [set(31, 1, '50', '10')] }] },
        { id: 4, cycleId: null, weekNumber: null, dayName: 'Orphan Day', date: '2026-09-29T18:00:00Z', possibleDuplicateOf: null,
          exercises: [{ name: 'Curls', sets: [set(41, 1, '20 kg', '12')] }] },
        { id: 5, cycleId: 3, weekNumber: 4, dayName: 'Old Day', date: '2026-05-01T18:00:00Z', possibleDuplicateOf: null,
          exercises: [{ name: 'Old Lift', sets: [set(51, 1, '100', '5')] }] }
    ]
};

(async () => {
    const { ctx } = harness(async () => ok({}));
    const hh = (state, ui) => ctx.historyHtml(state, Object.assign({ edit: null, busy: false, error: null }, ui || {}));

    console.log('\n=== before there is anything to show ===\n');
    check('loading', /Loading/.test(hh(null)), true);
    check('a failed load says so and offers a retry', /Could not load/.test(hh(null, { error: 'Could not load' })) && /Retry/.test(hh(null, { error: 'x' })), true);
    check('nothing logged', /Nothing logged yet/.test(hh({ workouts: [], cycle: null })), true);

    console.log('\n=== the list ===\n');
    let out = hh(WORKOUTS);
    check('sessions on no week come first, flagged as missing from Progress', out.indexOf('Not on any week') < out.indexOf('Week 2') && /do not appear in Progress/.test(out), true);
    check('this cycle is grouped by week, newest week first', out.indexOf('>Week 2<') < out.indexOf('>Week 1<'), true);
    check('older cycles come last', out.indexOf('Earlier cycles') > out.indexOf('>Week 1<') && out.includes('Old Lift'), true);
    check('the day is shown without its long description', out.includes('>Day 1<') && !out.includes('Squat Strength'), true);
    check('a possible duplicate is flagged', (out.match(/Possible duplicate/g) || []).length, 1);
    check('an edited set says so', /<em>edited<\/em>/.test(out), true);
    check('weights read naturally', out.includes('35 lb × 6') && out.includes('BW × 8') && out.includes('20 kg × 12'), true);
    check('every set can be edited', (out.match(/historyOpenEditor\('set'/g) || []).length, 7);
    check('every movement can get another set, or a new name', (out.match(/historyOpenEditor\('add'/g) || []).length === 5 && (out.match(/historyOpenEditor\('rename'/g) || []).length === 5, true);
    check('every session can be moved or deleted', (out.match(/historyDeleteWorkout\(/g) || []).length, 5);
    check('a session on no week asks for one', /<option value="">Choose…<\/option>/.test(out), true);
    check('the week picker offers every week of the cycle', (out.match(/<option value="6"/g) || []).length >= 1, true);
    check('a placed session has its week selected', /<option value="2" selected>/.test(out), true);
    check('with no active cycle there is no week picker content, and it still renders', hh({ workouts: WORKOUTS.workouts, cycle: null }).includes('Weighted Pull-Up'), true);

    console.log('\n=== editing ===\n');
    out = hh(WORKOUTS, { edit: { kind: 'set', workoutId: 1, setId: 11 } });
    check('opening a set shows its numbers, ready to change', /id="hist-weight"[^>]*value="35"/.test(out) && /id="hist-reps"[^>]*value="6"/.test(out), true);
    check('with save, delete and cancel', /historySaveSet\(1, 11\)/.test(out) && /historyDeleteSet\(1, 11\)/.test(out) && /historyCancel\(\)/.test(out), true);
    check('only that set is open', (out.match(/id="hist-weight"/g) || []).length, 1);
    out = hh(WORKOUTS, { edit: { kind: 'set', workoutId: 1, setId: 13 } });
    check('a bodyweight set opens with a blank weight', /id="hist-weight"[^>]*value=""/.test(out), true);
    out = hh(WORKOUTS, { edit: { kind: 'add', workoutId: 1, exIdx: 0 } });
    check('adding a set starts from the last weight', /id="hist-weight"[^>]*value="BW"/.test(out) || /id="hist-weight"[^>]*value=""/.test(out), true);
    check('and has an "Add set" button', /historyAddSet\(1, 0\)/.test(out), true);
    out = hh(WORKOUTS, { edit: { kind: 'rename', workoutId: 3, exIdx: 0 } });
    check('renaming starts from the current name', /id="hist-name"[^>]*value="Flat Dumbbell Bench Press"/.test(out), true);
    out = hh(WORKOUTS, { busy: true, error: 'Reps must be a number' });
    check('while saving, buttons are disabled', (out.match(/disabled/g) || []).length > 5, true);
    check('an error is shown', out.includes('Reps must be a number'), true);

    console.log('\n=== untrusted text ===\n');
    const evil = '<img src=x onerror=alert(1)>';
    out = hh({ cycle: WORKOUTS.cycle, workouts: [{ id: 9, cycleId: 7, weekNumber: 1, dayName: evil, date: '2026-09-21T18:00:00Z', possibleDuplicateOf: null, exercises: [{ name: evil, sets: [set(91, 1, evil, evil)] }] }] },
        { edit: { kind: 'rename', workoutId: 9, exIdx: 0 }, error: evil });
    check('nothing logged can inject markup (editing)', out.includes('<img src=x'), false);
    check('it is shown as text instead (editing)', out.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
    const evilState = { cycle: WORKOUTS.cycle, workouts: [{ id: 9, cycleId: 7, weekNumber: 1, dayName: evil, date: '2026-09-21T18:00:00Z', possibleDuplicateOf: null, exercises: [{ name: evil, sets: [set(91, 1, evil, evil)] }] }] };
    out = hh(evilState);
    check('nothing logged can inject markup (reading)', out.includes('<img src=x'), false);
    check('the movement name, day and values are all shown as text', (out.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 3, true);
    out = hh(evilState, { edit: { kind: 'set', workoutId: 9, setId: 91 } });
    check('nothing logged can inject markup (editing a set)', out.includes('<img src=x') || out.includes('"><img'), false);

    console.log('\n=== loading and changing ===\n');
    let responses;
    const make = (extra) => {
        responses = Object.assign({
            'GET /api/workouts': () => ok(WORKOUTS),
            'GET /api/user/data': () => ok({ workoutJournal: [{ id: 1, exercises: [] }] })
        }, extra || {});
        return harness(async (url, o) => {
            const k = ((o && o.method) || 'GET') + ' ' + url;
            return responses[k] ? responses[k]() : ok({ ok: true });
        });
    };

    let h = make();
    await h.ctx.loadHistory();
    check('opening the screen asks for the history, with the token', h.calls[0].url === '/api/workouts', true);
    check('and draws it', /Logged workouts|Week 2/.test(h.el('history-body').innerHTML), true);

    h = make(); await h.ctx.loadHistory(); h.calls.length = 0;
    h.ctx.historyOpenEditor('set', 1, 11);
    check('opening the editor is remembered', h.state().historyEdit.setId, 11);
    h.el('hist-weight').value = '40'; h.el('hist-reps').value = '7';
    h.ctx.__setMetrics({ stale: true });
    await h.ctx.historySaveSet(1, 11);
    const patch = h.calls.find(c => c.method === 'PATCH');
    check('saving sends what was typed', [patch.url, patch.body], ['/api/workouts/1/sets/11', { weight: '40', reps: '7' }]);
    check('then re-reads the history', h.calls.some(c => c.method === 'GET' && c.url === '/api/workouts'), true);
    check('and brings this phone\'s own copy into line with the server', (() => { try { return JSON.parse(h.store.get('workoutJournal'))[0].id; } catch (e) { return 'missing'; } })(), 1);
    check('Progress is rebuilt from the corrected history', h.state().metricsCache, null);
    check('the editor closes', h.state().historyEdit, null);

    h = make({ 'GET /api/user/data': () => ok({ workoutJournal: [] }) });
    await h.ctx.loadHistory();
    h.store.set('workoutJournal', JSON.stringify([{ id: 99, stale: true }]));
    await h.ctx.historyDeleteWorkout(1);
    check('a corrected-away history is not resurrected from the phone\'s old copy', h.store.get('workoutJournal'), '[]');

    h = make(); await h.ctx.loadHistory(); h.calls.length = 0;
    h.ctx.__confirm = false;
    await h.ctx.historyDeleteSet(1, 11);
    check('deleting a set asks first', h.confirms.length, 1);
    check('and does nothing if declined', h.calls.length, 0);
    h.ctx.__confirm = true;
    await h.ctx.historyDeleteSet(1, 11);
    check('confirmed, it deletes that set', h.calls.some(c => c.method === 'DELETE' && c.url === '/api/workouts/1/sets/11'), true);

    h = make(); await h.ctx.loadHistory(); h.calls.length = 0; h.ctx.__confirm = false;
    await h.ctx.historyDeleteWorkout(2);
    check('deleting a session asks first, and declining does nothing', [h.confirms.length, h.calls.length], [1, 0]);
    h.ctx.__confirm = true;
    await h.ctx.historyDeleteWorkout(2);
    check('confirmed, it deletes the session', h.calls.some(c => c.method === 'DELETE' && c.url === '/api/workouts/2'), true);

    h = make(); await h.ctx.loadHistory(); h.calls.length = 0;
    h.el('hist-weight').value = '35'; h.el('hist-reps').value = '4';
    await h.ctx.historyAddSet(1, 0);
    check('adding a set sends the movement\'s own name, looked up safely', h.calls.find(c => c.method === 'POST').body, { exercise: 'Weighted Pull-Up', weight: '35', reps: '4' });
    h.calls.length = 0; h.el('hist-name').value = 'Pull-Up (Weighted)';
    await h.ctx.historyRename(1, 0);
    check('renaming sends old and new', h.calls.find(c => c.method === 'PATCH').body, { from: 'Weighted Pull-Up', to: 'Pull-Up (Weighted)' });
    h.calls.length = 0;
    await h.ctx.historyMove(4, '2');
    check('moving a session sends the week as a number', h.calls.find(c => c.method === 'PATCH').body, { weekNumber: 2 });
    h.calls.length = 0;
    await h.ctx.historyMove(4, '');
    check('choosing the blank option does nothing', h.calls.length, 0);

    h = make({ 'PATCH /api/workouts/1/sets/11': () => bad(400, { error: 'Reps must be a number' }) });
    await h.ctx.loadHistory();
    h.ctx.historyOpenEditor('set', 1, 11); h.el('hist-weight').value = '40'; h.el('hist-reps').value = 'abc';
    await h.ctx.historySaveSet(1, 11);
    check('a rejected change shows the server\'s reason', /Reps must be a number/.test(h.el('history-body').innerHTML), true);
    check('and leaves the editor open to fix it', [h.state().historyEdit.setId, h.state().historyBusy], [11, false]);
    check('and does not touch the phone\'s copy', h.store.has('workoutJournal'), false);

    const releases = [];
    h = make({ 'PATCH /api/workouts/1/sets/11': () => new Promise(r => { releases.push(() => r(ok({ ok: true }))); }) });
    await h.ctx.loadHistory();
    const first = h.ctx.historySaveSet(1, 11);
    await new Promise(r => setTimeout(r, 5));
    const secondRequest = h.ctx.historySaveSet(1, 11);
    await new Promise(r => setTimeout(r, 5));
    releases.forEach(r => r());
    await first;
    const second = await secondRequest;
    check('a second tap while saving is ignored', [second, h.calls.filter(c => c.method === 'PATCH').length], [false, 1]);

    h = make({ 'GET /api/workouts': () => bad(500) });
    await h.ctx.loadHistory();
    check('a failed load is an error with a retry, not a blank screen', /Retry/.test(h.el('history-body').innerHTML), true);

    console.log('\n=== Progress points here ===\n');
    const rows = (...r) => r.flat();
    const sets = (week, name, w, reps, extra) => reps.map(x => Object.assign({
        workout_id: 1000 + week, finished_at: '2026-06-0' + week + 'T10:00:00Z', cycle_id: 1, week_number: week,
        exercise_name: name, weight_value: w, weight_unit: 'lb', is_bodyweight: false, reps_value: x, swapped_from: null
    }, extra || {}));
    const snap = computeCycleSnapshot(rows(
        sets(1, 'Pull-Up', 35, [6, 5, 5, 4], { workout_id: 11, day_name: 'Day 1 - Squat' }),
        sets(1, 'Pull-Up', 35, [5, 5, 4], { workout_id: 12, day_name: 'Day 2 - Bench' }),
        sets(1, 'Hidden Bench', 50, [10], { workout_id: 13, cycle_id: null, week_number: null })
    ), { id: 1, total_weeks: 6, program: null });
    const metrics = ctx.metricsHtml({ cycle: snap, counts: { allTime: 3 }, totalSets: 8 }, { openLift: 0, groupOpen: false });
    check('work on no week is called out, by name', /not on any week/.test(metrics) && metrics.includes('Hidden Bench'), true);
    check('with a way to fix it', /Put it on a week/.test(metrics) && /openHistory\(\)/.test(metrics), true);
    check('an open lift shows each session on its own line', /Week 1 · Day 1/.test(metrics) && /Week 1 · Day 2/.test(metrics), true);
    check('so a lift done on two days no longer reads as one long list of sets', metrics.includes('6 · 5 · 5 · 4') && metrics.includes('5 · 5 · 4'), true);
    check('with a link to edit those sets', /Edit these sets/.test(metrics), true);
    check('and a button for editing everything', /Edit logged workouts/.test(metrics), true);
    check('no notice when nothing is loose', /not on any week/.test(ctx.metricsHtml({ cycle: computeCycleSnapshot(sets(1, 'Row', 100, [10]), { id: 1, total_weeks: 6 }), counts: { allTime: 1 }, totalSets: 1 }, { openLift: null, groupOpen: false })), false);
    const onlyLoose = computeCycleSnapshot(sets(1, 'Hidden Bench', 50, [10], { cycle_id: null, week_number: null }), { id: 1, total_weeks: 6 });
    const emptyView = ctx.metricsHtml({ cycle: onlyLoose, counts: { allTime: 1 }, totalSets: 1 }, { openLift: null, groupOpen: false });
    const bw = (week, reps, extra) => sets(week, 'Pull Ups', null, reps, Object.assign({ is_bodyweight: true, day_name: 'Day 1 - Squat' }, extra));
    const bwSnap = computeCycleSnapshot([...bw(1, [6, 5, 5, 4], { workout_id: 21 }), ...bw(1, [5, 5, 4], { workout_id: 22 }), ...bw(2, [6, 6, 5, 4], { workout_id: 23 })], { id: 1, total_weeks: 6 });
    const bwHtml = ctx.metricsHtml({ cycle: bwSnap, counts: { allTime: 3 }, totalSets: 11 }, { openLift: null, groupOpen: false });
    check('a bodyweight lift whose week 1 was saved twice reads +1 rep per session', /\+1 reps/.test(bwHtml), true);
    check('and never shows the false "-13 reps" collapse', /13 reps/.test(bwHtml), false);
    const lateLift = computeCycleSnapshot([...sets(1, 'Squat', 185, [5]), ...sets(2, 'Flat Dumbbell Bench Press', 50, [10, 9])], { id: 1, total_weeks: 6, program: null });
    const lateHtml = ctx.metricsHtml({ cycle: lateLift, counts: { allTime: 2 }, totalSets: 3 }, { openLift: null, groupOpen: false });
    const benchCard = lateHtml.slice(lateHtml.indexOf('Flat Dumbbell Bench Press'));
    check('a weighted lift in its first week is not labelled "Bodyweight"', /Bodyweight/.test(benchCard.slice(0, 400)), false);
    check('a lift that started in week 2 shows week 1 as "not started", not "missed"', /ms-na/.test(benchCard.slice(0, 900)) && !/not logged/.test(benchCard.slice(0, 600)), true);
    check('a real bodyweight lift is still labelled as such', /Bodyweight/.test(ctx.metricsHtml({ cycle: computeCycleSnapshot(sets(1, 'Pull Ups', null, [8], { is_bodyweight: true }), { id: 1, total_weeks: 6 }), counts: { allTime: 1 }, totalSets: 1 }, { openLift: null, groupOpen: false })), true);
    check('even with nothing on the scorecard yet, loose work is not hidden', /Nothing logged yet/.test(emptyView) && /Hidden Bench/.test(emptyView), true);

    console.log('\n=== saving a workout exactly once ===\n');
    const makeRow = (exIndex, setNum, weight, reps, done) => {
        const row = { dataset: { done: done ? 'true' : 'false' }, classList: { add() {}, remove() {}, contains: () => false }, scrollIntoView() {} };
        const mk = isW => ({ value: isW ? weight : reps, getAttribute: k => (k === 'data-ex' ? String(exIndex) : String(setNum)), closest: () => row });
        row._w = mk(true); row._r = mk(false);
        row.querySelector = sel => (sel === '.workout-weight' ? row._w : row._r);
        return row;
    };
    const PLAN = { planName: 'P', days: [{ dayName: 'Day 1', exercises: [{ name: 'Weighted Pull-Up', sets: 4, reps: '4-6' }] }] };
    const postsOf = hx => hx.calls.filter(c => c.method === 'POST' && c.url === '/api/workouts');

    h = harness(async () => ok({ success: true }), { rows: [makeRow(0, 1, '35', '6', true), makeRow(0, 2, '35', '5', true)] });
    h.ctx.__arm(PLAN, 0, Date.now() - 60000, 'workout-abc');
    await h.ctx.finishWorkout();
    let log = postsOf(h)[0].body;
    check('a saved workout carries the id it was given at the start', log.clientId, 'workout-abc');
    check('and which day of the plan it was', log.dayIndex, 0);
    check('the id is retired once it is saved', h.state().workoutClientId, null);
    check('the local copy has the id too, so a re-upload is recognised', (() => { try { return JSON.parse(h.store.get('workoutJournal'))[0].clientId; } catch (e) { return 'missing'; } })(), 'workout-abc');

    const gates = [];
    h = harness(async (url, o) => (o && o.method === 'POST' && url === '/api/workouts' ? new Promise(r => { gates.push(() => r(ok({ success: true }))); }) : ok({})),
        { rows: [makeRow(0, 1, '35', '6', true)] });
    h.ctx.__arm(PLAN, 0, Date.now() - 60000, 'workout-dbl');
    const a = h.ctx.finishWorkout();
    await new Promise(r => setTimeout(r, 5));
    const b = h.ctx.finishWorkout(); const c = h.ctx.finishWorkout();
    await new Promise(r => setTimeout(r, 5));
    gates.forEach(g => g()); await Promise.all([a, b, c]);
    check('tapping Finish three times saves once', postsOf(h).length, 1);
    check('and the button works again afterwards', h.state().finishingWorkout, false);

    h = harness(async () => ok({}), { rows: [makeRow(0, 1, '35', '6', true)] });
    h.ctx.__arm(PLAN, 0, Date.now(), null);
    await h.ctx.finishWorkout();
    check('a workout with no id yet is given one rather than saved without', typeof postsOf(h)[0].body.clientId === 'string' && postsOf(h)[0].body.clientId.length > 8, true);

    h = harness(async () => ok({}));
    h.ctx.__arm(PLAN, 0, Date.now(), null);
    h.ctx.startWorkout(0);
    const started = JSON.parse(h.store.get('activeWorkout'));
    check('a new workout is given an id as it starts', typeof started.clientId === 'string' && started.clientId.length > 8, true);
    check('which is kept in the in-progress copy, so it survives a reload', h.state().workoutClientId, started.clientId);

    h = harness(async () => ok({}));
    h.ctx.__arm(PLAN, 0, Date.now(), null);
    h.ctx.startWorkout(0, { resumeFrom: { dayIndex: 0, startedAt: Date.now() - 600000, clientId: 'resumed-id', sets: [], exercises: [{ name: 'Weighted Pull-Up' }] } });
    check('resuming after a reload keeps the SAME id', h.state().workoutClientId, 'resumed-id');
    check('and keeps it in the in-progress copy', JSON.parse(h.store.get('activeWorkout')).clientId, 'resumed-id');

    h = harness(async () => ok({}));
    h.ctx.startWorkout = h.ctx.startWorkout;
    check('two workouts get different ids', (() => { const x = h.ctx.newClientId(), y = h.ctx.newClientId(); return x !== y && x.length > 8; })(), true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
