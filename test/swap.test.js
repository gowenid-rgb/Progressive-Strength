/*
 * T3-9 — mid-workout exercise swaps.
 *
 * Three layers: the static alternatives library, the cycle-level substitution store, and the
 * client behaviour (what actually gets logged after a swap).
 */
process.env.JWT_SECRET = 'swap-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const http = require('http');
const { installPgShim, makeChecker } = require('./helpers/pgshim');

const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

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
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(d); } catch (e) { parsed = d; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

/* Loads the app's inline script plus exercises.js into one stubbed context. */
function clientHarness(plan) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .sort((a, b) => b.length - a.length)[0]
        .replace(/^<script>/, '').replace(/<\/script>$/, '');
    const lib = fs.readFileSync(path.join(ROOT, 'public', 'exercises.js'), 'utf8');

    const store = new Map();
    const log = { alerts: [], fetches: [], nav: null };
    const els = new Map();

    const fakeEl = () => ({
        innerHTML: '', textContent: '', value: '', className: '',
        dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
        querySelector: () => null, scrollIntoView() {}
    });

    const ctx = {
        console, Date, JSON, Math, parseInt, Array, Object, String, Number,
        setInterval: () => 0, clearInterval: () => {},
        navigator: {}, window: { addEventListener() {} }, self: {},
        alert: m => log.alerts.push(m),
        confirm: () => false,
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k)
        },
        fetch: async (url, opts) => {
            log.fetches.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
            return { ok: true, json: async () => ({ success: true }) };
        },
        document: {
            addEventListener() {},
            getElementById: id => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
            querySelector: sel => { if (!els.has(sel)) els.set(sel, fakeEl()); return els.get(sel); },
            querySelectorAll: () => []
        }
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(lib + '\n' + inline + `
        renderPlan = function () {};
        nav = function (s) { __log.nav = s; };
        syncData = async function () { __log.synced = true; };
        globalThis.__setup = function (p) { currentWorkoutPlan = p; activeDayIndex = 0; };
        globalThis.__plan = function () { return currentWorkoutPlan; };
    `, Object.assign(ctx, { __log: log }));

    ctx.__setup(plan);
    return { ctx, store, log };
}

(async () => {
    const pg = installPgShim();
    const lib = require(path.join(ROOT, 'public', 'exercises.js'));

    console.log('\n=== T3-9: the alternatives library ===\n');

    check('pull ups suggest a vertical pull', lib.alternativesFor('Pull Ups').includes('Lat Pulldown'), true);
    check('pull ups suggest an assisted variant', lib.alternativesFor('Pull Ups').includes('Assisted Pull Up'), true);
    check('bench press suggests a horizontal push', lib.alternativesFor('Barbell Bench Press').includes('Dumbbell Bench Press'), true);

    // Order sensitivity: these would be misclassified if general patterns ran first.
    check('romanian deadlift is a hinge, not a squat', lib.patternFor('Romanian Deadlift').id, 'hinge');
    check('leg curl is a hamstring movement, not a biceps curl', lib.patternFor('Seated Leg Curl').id, 'hamstring');
    check('dumbbell curl is biceps', lib.patternFor('Dumbbell Curl').id, 'biceps');
    check('lat pulldown is a vertical pull', lib.patternFor('Lat Pulldown').id, 'vertical-pull');

    // Names come from a language model, so matching has to tolerate variation.
    check('handles punctuation and casing', lib.patternFor('Bench Press (Barbell)').id, 'horizontal-push');
    check('handles hyphenation', lib.patternFor('Chin-Ups').id, 'vertical-pull');

    check('never suggests the exercise itself', lib.alternativesFor('Lat Pulldown').includes('Lat Pulldown'), false);
    check('unknown movement yields no suggestions', lib.alternativesFor('Interpretive Dance'), []);
    check('empty name is safe', lib.alternativesFor(''), []);
    check('null name is safe', lib.alternativesFor(null), []);

    console.log('\n=== T3-9: swapping in the workout player ===\n');

    const basePlan = () => ({
        planName: 'Test',
        days: [
            { dayName: 'Pull', exercises: [{ name: 'Pull Ups', sets: 3, reps: '8', suggestedWeight: 'BW' }, { name: 'Barbell Row', sets: 3, reps: '8' }] },
            { dayName: 'Pull B', exercises: [{ name: 'Pull Ups', sets: 3, reps: '6' }] },
            { dayName: 'Done', completed: true, exercises: [{ name: 'Pull Ups', sets: 3, reps: '10' }] }
        ]
    });

    // Session-only swap.
    let h = clientHarness(basePlan());
    await h.ctx.applySwap(0, 'Lat Pulldown', false);
    let plan = h.ctx.__plan();
    check('session swap renames the exercise', plan.days[0].exercises[0].name, 'Lat Pulldown');
    check('session swap records what it replaced', plan.days[0].exercises[0].swappedFrom, 'Pull Ups');
    check('session swap drops the old suggested weight', plan.days[0].exercises[0].suggestedWeight, undefined);
    check('session swap leaves other days alone', plan.days[1].exercises[0].name, 'Pull Ups');
    check('session swap makes no server call', h.log.fetches.length, 0);

    // Persistent swap.
    h = clientHarness(basePlan());
    await h.ctx.applySwap(0, 'Lat Pulldown', true);
    plan = h.ctx.__plan();
    check('persistent swap rewrites future days', plan.days[1].exercises[0].name, 'Lat Pulldown');
    check('persistent swap does NOT rewrite completed days', plan.days[2].exercises[0].name, 'Pull Ups');
    check('persistent swap leaves unrelated movements alone', plan.days[0].exercises[1].name, 'Barbell Row');

    const subCall = h.log.fetches.find(f => f.url === '/api/cycle/substitutions');
    check('persistent swap records a standing substitution', !!subCall, true);
    check('substitution names the original', JSON.parse(subCall.body).from, 'Pull Ups');
    check('substitution names the replacement', JSON.parse(subCall.body).to, 'Lat Pulldown');

    // Chained swaps must still report the original movement.
    h = clientHarness(basePlan());
    await h.ctx.applySwap(0, 'Lat Pulldown', false);
    await h.ctx.applySwap(0, 'Seated Cable Row', false);
    plan = h.ctx.__plan();
    check('chained swap keeps the ROOT original', plan.days[0].exercises[0].swappedFrom, 'Pull Ups');
    check('chained swap uses the latest name', plan.days[0].exercises[0].name, 'Seated Cable Row');

    // Swapping to the same movement is a no-op.
    h = clientHarness(basePlan());
    await h.ctx.applySwap(0, 'Pull Ups', true);
    check('swapping to itself changes nothing', h.ctx.__plan().days[0].exercises[0].swappedFrom, undefined);
    check('swapping to itself makes no server call', h.log.fetches.length, 0);

    console.log('\n=== T3-9: substitutions persist on the cycle ===\n');

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
    const ran = await require(path.join(ROOT, 'migrate.js')).migrate(db);
    check('migration 002 applies', ran.includes('002_cycle_substitutions.sql'), true);

    const reg = await req('POST', '/api/auth/register', { email: 'swapper@example.com', password: 'password1234' });
    const token = reg.body.token;

    const noCycle = await req('POST', '/api/cycle/substitutions', { from: 'A', to: 'B' }, token);
    check('substitution without a cycle is a clean 400', noCycle.status, 400);

    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Pull Ups', sets: 3, reps: '8' }] }] },
        cycleOptions: { totalWeeks: 6 }
    }, token);

    let r = await req('POST', '/api/cycle/substitutions', { from: 'Pull Ups', to: 'Lat Pulldown' }, token);
    check('substitution saved', r.status, 200);
    check('one rule stored', r.body.substitutions.length, 1);

    const blank = await req('POST', '/api/cycle/substitutions', { from: '', to: 'X' }, token);
    check('empty substitution rejected', blank.status, 400);

    // Re-swapping the same movement replaces the rule instead of stacking a contradiction.
    r = await req('POST', '/api/cycle/substitutions', { from: 'Pull Ups', to: 'Chest-Supported Row' }, token);
    check('re-swapping replaces rather than appends', r.body.substitutions.length, 1);
    check('rule points at the newest replacement', r.body.substitutions[0].to, 'Chest-Supported Row');

    // Chains collapse: A->B then B->C should leave A->C, not a stale hop through B.
    await req('POST', '/api/cycle/substitutions', { from: 'Back Squat', to: 'Front Squat' }, token);
    r = await req('POST', '/api/cycle/substitutions', { from: 'Front Squat', to: 'Hack Squat' }, token);
    const backSquat = r.body.substitutions.find(x => x.from === 'Back Squat');
    check('chained rules collapse to the final movement', backSquat.to, 'Hack Squat');

    const stored = await pg.query('SELECT substitutions FROM cycles ORDER BY id DESC LIMIT 1');
    check('substitutions persisted on the cycle row', stored.rows[0].substitutions.length >= 2, true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
