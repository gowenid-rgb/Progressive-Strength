/*
 * In-progress workout persistence.
 *
 * Everything about an active workout used to live in memory and in DOM inputs, so a reload
 * lost the session entirely. These assertions exist because that loss was silent — nothing
 * errored, the sets simply were not there — and because a later refactor could reintroduce it
 * exactly the way changing syncData() quietly broke the T1-1 rescue rule.
 */
process.env.JWT_SECRET = 'resume-test-secret-long-enough-to-avoid-warnings';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

/* A DOM stub rich enough for the snapshot path: set rows with real inputs. */
function makeRow(exIndex, setNum, weight, reps, done) {
    const row = {
        dataset: { done: done ? 'true' : 'false' },
        classList: { add() {}, remove() {}, contains: () => false },
        scrollIntoView() {}
    };
    const mk = isWeight => ({
        value: isWeight ? weight : reps,
        getAttribute: k => (k === 'data-ex' ? String(exIndex) : String(setNum)),
        closest: () => row
    });
    row._w = mk(true);
    row._r = mk(false);
    row.querySelector = sel => (sel === '.workout-weight' ? row._w : row._r);
    return row;
}

function harness(rows, storage) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .sort((a, b) => b.length - a.length)[0]
        .replace(/^<script>/, '').replace(/<\/script>$/, '');

    const store = new Map(Object.entries(storage || {}));
    const log = { confirms: [], nav: null };
    const el = () => ({
        innerHTML: '', innerText: '', textContent: '', value: '', className: '', oninput: null,
        dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
        querySelector: () => null, scrollIntoView() {}
    });

    const ctx = {
        console, Date, JSON, Math, parseInt, Array, Object, String, Number, Set,
        setInterval: () => 0, clearInterval: () => {},
        navigator: {}, window: { addEventListener() {} }, self: {},
        alert: () => {},
        confirm: m => { log.confirms.push(m); return ctx.__confirmAnswer; },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k)
        },
        document: {
            addEventListener() {},
            getElementById: () => el(),
            querySelector: () => null,
            querySelectorAll: sel => (String(sel).includes('.set-row') ? rows : [])
        }
    };
    ctx.self = ctx;
    ctx.__confirmAnswer = true;
    vm.createContext(ctx);
    vm.runInContext(inline + `
        renderPlan = function () {};
        nav = function (s) { __log.nav = s; };
        startWorkout = function (i, opts) { __log.started = { dayIndex: i, opts: opts || null }; };
        advanceWeek = async function () { __log.advanced = (__log.advanced || 0) + 1; };
        showBuildingWeek = function (w, t) { __log.building = { week: w, total: t }; };
        hideBuildingWeek = function () { __log.hidBuilding = true; };
        globalThis.__setCycle = function (c) { currentCycle = c; };
        globalThis.__set = function (plan, dayIdx, startedAt) {
            currentWorkoutPlan = plan; activeDayIndex = dayIdx; workoutStartTime = startedAt;
        };
    `, Object.assign(ctx, { __log: log }));

    return { ctx, store, log };
}

const PLAN = {
    planName: 'Block',
    days: [{ dayName: 'Push', exercises: [{ name: 'Bench Press' }, { name: 'Pull Ups' }] }]
};

(async () => {
    console.log('\n=== snapshotting an in-progress workout ===\n');

    let rows = [
        makeRow(0, 1, '185', '5', true),
        makeRow(0, 2, '190', '4', false),
        makeRow(0, 3, '', '', false)
    ];
    let h = harness(rows, {});
    h.ctx.__set(PLAN, 0, Date.now() - 600000);
    h.ctx.saveActiveWorkout();

    let snap = JSON.parse(h.store.get('activeWorkout'));
    check('snapshot written', !!snap, true);
    check('every row captured, typed or not', snap.sets.length, 3);
    check('typed values captured', snap.sets[0].weight + 'x' + snap.sets[0].reps, '185x5');
    check('checkmark captured', snap.sets[0].done, true);
    check('unchecked row captured as unchecked', snap.sets[1].done, false);
    check('untouched row captured empty', snap.sets[2].weight, '');
    check('day index captured', snap.dayIndex, 0);
    check('original start time captured', typeof snap.startedAt, 'number');
    check('exercise names captured for session swaps', snap.exercises[1].name, 'Pull Ups');

    // Nothing to snapshot before a workout starts.
    h = harness(rows, {});
    h.ctx.__set(PLAN, 0, null);
    h.ctx.saveActiveWorkout();
    check('no snapshot when no workout is running', h.store.has('activeWorkout'), false);

    console.log('\n=== restoring after a reload ===\n');

    const fresh = () => ({
        dayIndex: 0,
        startedAt: Date.now() - 600000,
        savedAt: Date.now() - 30000,
        exercises: [{ name: 'Bench Press', swappedFrom: null }, { name: 'Lat Pulldown', swappedFrom: 'Pull Ups' }],
        sets: [{ ex: 0, set: '1', weight: '185', reps: '5', done: true }]
    });

    // Capture once: fresh() stamps Date.now() on each call, so comparing two calls compares
    // two different milliseconds.
    const recent = fresh();
    h = harness([], { activeWorkout: JSON.stringify(recent) });
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    let took = h.ctx.restoreActiveWorkout();
    check('recent workout resumes without asking', took, true);
    check('no confirm for a recent workout', h.log.confirms.length, 0);
    check('startWorkout called with the right day', h.log.started.dayIndex, 0);
    check('startWorkout told to resume', !!h.log.started.opts.resumeFrom, true);
    check('original start time passed through', h.log.started.opts.resumeFrom.startedAt, recent.startedAt);

    // Session-only swaps must be reapplied before the rows render.
    h = harness([], { activeWorkout: JSON.stringify(fresh()) });
    const planCopy = JSON.parse(JSON.stringify(PLAN));
    h.ctx.__set(planCopy, 0, null);
    h.ctx.restoreActiveWorkout();
    check('session swap reapplied on resume', planCopy.days[0].exercises[1].name, 'Lat Pulldown');
    check('swap origin reapplied', planCopy.days[0].exercises[1].swappedFrom, 'Pull Ups');

    console.log('\n=== stale and invalid snapshots ===\n');

    const stale = Object.assign(fresh(), { savedAt: Date.now() - 30 * 3600000 });

    h = harness([], { activeWorkout: JSON.stringify(stale) });
    h.ctx.__confirmAnswer = true;
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    took = h.ctx.restoreActiveWorkout();
    check('stale workout asks first', h.log.confirms.length, 1);
    check('stale workout resumes when accepted', took, true);

    h = harness([], { activeWorkout: JSON.stringify(stale) });
    h.ctx.__confirmAnswer = false;
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    took = h.ctx.restoreActiveWorkout();
    check('declining discards it', took, false);
    check('declining clears storage', h.store.has('activeWorkout'), false);

    // A day finished on another device is no longer resumable here.
    const donePlan = JSON.parse(JSON.stringify(PLAN));
    donePlan.days[0].completed = true;
    h = harness([], { activeWorkout: JSON.stringify(fresh()) });
    h.ctx.__set(donePlan, 0, null);
    check('completed day is not resumable', h.ctx.restoreActiveWorkout(), false);
    check('completed day clears the snapshot', h.store.has('activeWorkout'), false);

    // A snapshot pointing at a day the plan no longer has.
    h = harness([], { activeWorkout: JSON.stringify(Object.assign(fresh(), { dayIndex: 9 })) });
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    check('missing day is not resumable', h.ctx.restoreActiveWorkout(), false);
    check('missing day clears the snapshot', h.store.has('activeWorkout'), false);

    h = harness([], { activeWorkout: 'not json' });
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    check('corrupt snapshot does not throw', h.ctx.restoreActiveWorkout(), false);

    h = harness([], {});
    h.ctx.__set(JSON.parse(JSON.stringify(PLAN)), 0, null);
    check('no snapshot is a no-op', h.ctx.restoreActiveWorkout(), false);

    console.log('\n=== the snapshot belongs to the session ===\n');

    h = harness([], {
        token: 'T', currentWorkoutPlan: JSON.stringify(PLAN),
        workoutJournal: '[]', journalEntries: '[]',
        activeWorkout: JSON.stringify(fresh())
    });
    h.ctx.clearLocalSession();
    check('logout clears the in-progress workout', h.store.has('activeWorkout'), false);
    check('logout clears the plan too', h.store.has('currentWorkoutPlan'), false);

    console.log('\n=== the week rolls over on its own ===\n');

    // Finishing the last day of a week used to leave a "Start Week 2" button for the user to
    // find. The week is over; the next one is what they want.
    const weekPlan = done => ({
        planName: 'Block',
        days: [
            { dayName: 'A', completed: done, exercises: [{ name: 'Squat' }] },
            { dayName: 'B', completed: done, exercises: [{ name: 'Bench' }] }
        ]
    });

    h = harness([], {});
    h.ctx.__set(weekPlan(true), 0, null);
    h.ctx.__setCycle({ id: 1, totalWeeks: 6, currentWeek: 1 });
    await h.ctx.maybeAdvanceWeek();
    check('every day done advances the week', h.log.advanced, 1);
    check('the wait is explained rather than silent', h.log.building.week, 2);
    check('building state names the cycle length', h.log.building.total, 6);
    check('building state is cleared afterwards', h.log.hidBuilding, true);

    // Mid-week must not advance.
    const partial = weekPlan(true);
    partial.days[1].completed = false;
    h = harness([], {});
    h.ctx.__set(partial, 0, null);
    h.ctx.__setCycle({ id: 1, totalWeeks: 6, currentWeek: 1 });
    await h.ctx.maybeAdvanceWeek();
    check('an unfinished day does not advance', h.log.advanced, undefined);
    check('no building state mid-week', h.log.building, undefined);

    // The last week of a cycle ends the cycle; the cycle-complete card handles that.
    h = harness([], {});
    h.ctx.__set(weekPlan(true), 0, null);
    h.ctx.__setCycle({ id: 1, totalWeeks: 6, currentWeek: 6 });
    await h.ctx.maybeAdvanceWeek();
    check('the final week does not auto-advance', h.log.advanced, undefined);

    // No cycle at all (a plan generated before cycles existed) must not throw.
    h = harness([], {});
    h.ctx.__set(weekPlan(true), 0, null);
    h.ctx.__setCycle(null);
    await h.ctx.maybeAdvanceWeek();
    check('no cycle is a safe no-op', h.log.advanced, undefined);

    h = harness([], {});
    h.ctx.__set(null, 0, null);
    h.ctx.__setCycle({ id: 1, totalWeeks: 6, currentWeek: 1 });
    await h.ctx.maybeAdvanceWeek();
    check('no plan is a safe no-op', h.log.advanced, undefined);

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
