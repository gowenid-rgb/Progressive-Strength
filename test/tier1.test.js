/*
 * Tier 1 regression tests — session lifecycle (T1-1) and workout logging (T1-2).
 *
 * There is no build step and no test framework in this project, so this runs the real
 * inline <script> from public/index.html inside a stubbed DOM using node:vm. No
 * dependencies; run with `npm test`.
 *
 * These cover two bugs that produced no error message and corrupted data silently:
 *   T1-1  boot/login pushed stale local data over good server data, wiping lift history
 *   T1-2  unchecked sets were logged at the AI's suggested weight, inflating that history
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function extractInlineScript() {
    const html = fs.readFileSync(INDEX, 'utf8');
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
    if (!blocks.length) throw new Error('no inline <script> found in index.html');
    // The app's own script is the largest block (the others are Tailwind config).
    const biggest = blocks.sort((a, b) => b.length - a.length)[0];
    return biggest.replace(/^<script>/, '').replace(/<\/script>$/, '');
}

const code = extractInlineScript();

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

function baseCtx(store, extra) {
    const ctx = Object.assign({
        console, Date, JSON, Math, parseInt,
        setInterval: () => 0,
        clearInterval: () => {},
        navigator: {},
        window: { addEventListener() {} },
        alert: () => {},
        confirm: () => false,
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k)
        }
    }, extra);
    return ctx;
}

/* ------------------------------------------------------------------ T1-1 */

function sessionHarness(initialStore, serverData) {
    const store = new Map(Object.entries(initialStore));
    const calls = [];
    let bootHandler = null;

    const ctx = baseCtx(store, {
        fetch: async (url, opts) => {
            const method = (opts && opts.method) || 'GET';
            const headers = (opts && opts.headers) || {};
            calls.push({ url, method, headers, body: opts && opts.body });
            if (url === '/api/user/data' && method === 'GET') return { ok: true, json: async () => serverData };
            if (url.startsWith('/api/auth/')) return { ok: true, json: async () => ({ token: 'TOKEN-B', user: { id: 2 } }) };
            return { ok: true, json: async () => ({ success: true }) };
        },
        document: {
            addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') bootHandler = fn; },
            getElementById: () => ({ innerText: '', value: 'x', className: '', classList: { add() {}, remove() {} } }),
            querySelectorAll: () => []
        }
    });
    vm.createContext(ctx);
    ctx.__log = {};
    vm.runInContext(code + `
        renderPlan = function () {};
        nav = function (s) { __log.nav = s; };
        globalThis.__getPlan = function () { return currentWorkoutPlan; };
    `, ctx);
    return { ctx, store, calls, boot: () => bootHandler(), log: ctx.__log };
}

async function testSessionLifecycle() {
    console.log('\n=== T1-1: session lifecycle ===\n');

    // The original bug: fresh device, empty localStorage, server holds real history.
    // The old code POSTed the empty local journal straight back, wiping the server.
    let t = sessionHarness(
        { token: 'TOKEN-A' },
        { currentPlan: { planName: 'P', days: [] }, workoutJournal: [{ date: 'd1' }, { date: 'd2' }] }
    );
    await t.boot();
    check('boot makes NO POST to the server', t.calls.filter(c => c.method === 'POST').length, 0);
    check('server history hydrated locally', JSON.parse(t.store.get('workoutJournal')).length, 2);
    check('plan hydrated', JSON.parse(t.store.get('currentWorkoutPlan')).planName, 'P');
    check('navigated to plan screen', t.log.nav, 'screen-plan');

    // Server has no plan, but this browser holds a stale one.
    t = sessionHarness(
        { token: 'TOKEN-A', currentWorkoutPlan: JSON.stringify({ planName: 'STALE' }), workoutJournal: '[{"date":"old"}]' },
        { currentPlan: null, workoutJournal: [] }
    );
    await t.boot();
    check('stale plan cleared when server has none', t.store.get('currentWorkoutPlan'), undefined);
    check('stale journal replaced by server value', t.store.get('workoutJournal'), '[]');
    check('in-memory plan cleared', t.ctx.__getPlan(), null);
    check('sent to onboarding', t.log.nav, 'screen-onboarding');

    // No token, but leftover data from a previous user on this browser.
    t = sessionHarness(
        { currentWorkoutPlan: JSON.stringify({ planName: 'USER-A' }), workoutJournal: '[{"date":"a"}]', journalEntries: '[{"e":1}]' },
        {}
    );
    await t.boot();
    check('no-token boot clears leftover plan', t.store.get('currentWorkoutPlan'), undefined);
    check('no-token boot clears leftover journal', t.store.get('workoutJournal'), undefined);
    check('no-token boot clears leftover reflections', t.store.get('journalEntries'), undefined);
    check('sent to auth screen', t.log.nav, 'screen-auth');

    // User B logs in on a browser still holding user A's data.
    t = sessionHarness(
        { token: 'TOKEN-A', currentWorkoutPlan: JSON.stringify({ planName: 'USER-A-PLAN' }), workoutJournal: '[{"date":"a1"},{"date":"a2"}]' },
        { currentPlan: null, workoutJournal: [] }
    );
    await t.ctx.handleAuth('login');
    check('login makes NO data POST', t.calls.filter(c => c.method === 'POST' && c.url === '/api/user/data').length, 0);
    check("user A's plan gone after B logs in", t.store.get('currentWorkoutPlan'), undefined);
    check("user A's journal gone after B logs in", t.store.get('workoutJournal'), '[]');
    check('token replaced with B token', t.store.get('token'), 'TOKEN-B');
    const authCall = t.calls.find(c => c.url.startsWith('/api/auth/'));
    check('auth request sends no Authorization header', 'Authorization' in authCall.headers, false);
}

/* ------------------------------------------------------------------ T1-2 */

function makeRow(exIndex, setNum, weight, reps, done) {
    const classes = new Set();
    return {
        dataset: { done: done ? 'true' : 'false' },
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            contains: c => classes.has(c)
        },
        scrollIntoView() {},
        querySelector: sel => ({
            value: sel === '.workout-weight' ? weight : reps,
            getAttribute: k => (k === 'data-ex' ? String(exIndex) : String(setNum))
        })
    };
}

function workoutHarness(rows, confirmAnswers) {
    const store = new Map();
    const answers = confirmAnswers.slice();
    const log = { alerts: [], confirms: [], nav: null, synced: false };

    const ctx = baseCtx(store, {
        alert: m => log.alerts.push(m),
        confirm: m => { log.confirms.push(m); return answers.shift(); },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        document: {
            addEventListener() {},
            getElementById: () => ({ innerText: '', value: '', className: '', classList: { add() {}, remove() {} } }),
            querySelectorAll: sel => (sel.includes('.set-row') ? rows : [])
        }
    });
    vm.createContext(ctx);
    ctx.__log = log;
    vm.runInContext(code + `
        renderPlan = function () {};
        nav = function (s) { __log.nav = s; };
        syncData = async function () { __log.synced = true; };
        globalThis.__drive = async function (plan) {
            currentWorkoutPlan = plan;
            activeDayIndex = 0;
            workoutStartTime = Date.now() - 1000;
            workoutTimerInterval = null;
            await finishWorkout();
        };
    `, ctx);

    const plan = {
        planName: 'Test Plan',
        days: [{ dayName: 'Day A', exercises: [{ name: 'Squat' }, { name: 'Bench' }, { name: 'Row' }] }]
    };

    return ctx.__drive(plan).then(() => ({
        journal: JSON.parse(store.get('workoutJournal') || 'null'),
        planSaved: JSON.parse(store.get('currentWorkoutPlan') || 'null'),
        log
    }));
}

async function testWorkoutLogging() {
    console.log('\n=== T1-2: only checked sets are logged ===\n');

    // The original bug: 6 rows, only 2 checked, 4 completely untouched.
    // Old code logged all 6 at the AI's suggested weight.
    let r = await workoutHarness([
        makeRow(0, 1, '225', '5', true),
        makeRow(0, 2, '225', '5', true),
        makeRow(1, 1, '', '', false),
        makeRow(1, 2, '', '', false),
        makeRow(2, 1, '', '', false),
        makeRow(2, 2, '', '', false)
    ], []);
    check('logs exactly 1 exercise', r.journal[0].exercises.length, 1);
    check('logs exactly 2 sets', r.journal[0].exercises[0].sets.length, 2);
    check('logs the right exercise', r.journal[0].exercises[0].name, 'Squat');
    check('no nulls in exercises array', r.journal[0].exercises.filter(e => e === null).length, 0);
    check('no warning for untouched rows', r.log.confirms.length, 0);
    check('day marked complete', r.planSaved.days[0].completed, true);
    check('synced to server', r.log.synced, true);

    // Typed but unchecked: must warn, must not log those values.
    r = await workoutHarness([
        makeRow(0, 1, '225', '5', true),
        makeRow(1, 1, '135', '8', false)
    ], [false]); // Cancel = finish without them
    check('warned about unchecked row', r.log.confirms.length, 1);
    check('warning names the count', /^1 set has/.test(r.log.confirms[0]), true);
    check('unchecked values NOT logged', r.journal[0].exercises.length, 1);
    check('only the checked set logged', r.journal[0].exercises[0].sets[0].weight, '225');

    // Same, but user chooses Review: nothing written at all.
    r = await workoutHarness([
        makeRow(0, 1, '225', '5', true),
        makeRow(1, 1, '135', '8', false)
    ], [true]); // OK = review
    check('review writes no journal', r.journal, null);
    check('review does not navigate away', r.log.nav, null);
    check('review does not sync', r.log.synced, false);

    // Zero checked: discard prompt, nothing logged, day NOT completed.
    r = await workoutHarness([makeRow(0, 1, '', '', false), makeRow(1, 1, '', '', false)], [false]);
    check('zero checked writes no journal', r.journal, null);
    check('zero checked does not complete the day', r.planSaved, null);
    check('zero checked navigates back', r.log.nav, 'screen-plan');

    // Checked with blank weight is bodyweight, never the suggested load.
    r = await workoutHarness([makeRow(0, 1, '', '12', true)], []);
    check('blank weight logs as BW', r.journal[0].exercises[0].sets[0].weight, 'BW');
    check('reps preserved', r.journal[0].exercises[0].sets[0].reps, '12');
}

(async () => {
    await testSessionLifecycle();
    await testWorkoutLogging();
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})();
