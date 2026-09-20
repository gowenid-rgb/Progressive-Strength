/*
 * T3-11 — periodisation across arbitrary cycle lengths, plus the cycle endpoints.
 *
 * The old app hardcoded a 4-week Base/Build/Peak/Deload timeline that never advanced. These
 * assertions exist because "the timeline is decoration" was invisible without them.
 */
process.env.JWT_SECRET = 'cycles-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

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

(async () => {
    const pg = installPgShim();
    const cycles = require(path.join(ROOT, 'cycles.js'));

    console.log('\n=== T3-11: phases scale to any cycle length ===\n');

    const seq = n => Array.from({ length: n }, (_, i) => cycles.phaseForWeek(i + 1, n));

    // Short cycles must not waste a week deloading.
    check('2-week cycle has no deload', seq(2), ['build', 'peak']);
    check('3-week cycle has no deload', seq(3), ['base', 'build', 'peak']);

    check('4-week cycle ends in a deload', seq(4), ['base', 'build', 'peak', 'deload']);
    check('6-week cycle is progressive', seq(6), ['base', 'base', 'build', 'build', 'peak', 'deload']);
    check('8-week cycle is progressive', seq(8), ['base', 'base', 'base', 'build', 'build', 'peak', 'peak', 'deload']);
    check('every phase gets a week in a 4-week cycle', new Set(seq(4)).size, 4);
    check('every phase gets a week in a 16-week cycle', new Set(seq(16)).size, 4);

    // Properties that must hold at every supported length.
    let monotonic = true, deloadLast = true;
    const order = { base: 0, build: 1, peak: 2, deload: 3 };
    for (let n = cycles.MIN_WEEKS; n <= cycles.MAX_WEEKS; n++) {
        const s = seq(n);
        for (let i = 1; i < s.length; i++) if (order[s[i]] < order[s[i - 1]]) monotonic = false;
        if (n >= 4 && s[s.length - 1] !== 'deload') deloadLast = false;
    }
    check('phases never move backwards at any length', monotonic, true);
    check('every cycle of 4+ weeks ends in a deload', deloadLast, true);

    check('week beyond the cycle clamps to the last', cycles.phaseForWeek(99, 6), 'deload');
    check('week 0 clamps to the first', cycles.phaseForWeek(0, 6), 'base');

    check('phase list covers every week', cycles.phasesForCycle(6).length, 6);
    check('phase list carries display labels', cycles.phasesForCycle(4)[3].label, 'Deload');

    check('guidance names the week and total', /week 3 of a 6-week cycle/.test(cycles.phaseGuidance(3, 6)), true);
    check('guidance describes the phase', /Intensification/.test(cycles.phaseGuidance(3, 6)), true);

    console.log('\n=== T3-11: length is clamped to something trainable ===\n');

    check('too short clamps up', cycles.clampWeeks(1), cycles.MIN_WEEKS);
    check('too long clamps down', cycles.clampWeeks(52), cycles.MAX_WEEKS);
    check('nonsense falls back to 6', cycles.clampWeeks('banana'), 6);
    check('6 is unchanged', cycles.clampWeeks(6), 6);

    check('recommendation outside range rejected', cycles.validateRecommendation({ weeks: 40, rationale: 'x' }) !== null, true);
    check('recommendation without rationale rejected', cycles.validateRecommendation({ weeks: 6 }), 'missing rationale');
    check('valid recommendation accepted', cycles.validateRecommendation({ weeks: 6, rationale: 'Good fit.' }), null);

    console.log('\n=== T3-11: the cycle advances ===\n');

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

    const reg = await req('POST', '/api/auth/register', { email: 'cyclist@example.com', password: 'password1234' });
    const token = reg.body.token;

    const plan = { planName: 'Six Week Block', days: [{ dayName: 'A', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] }] };
    await req('POST', '/api/user/data', { currentPlan: plan, cycleOptions: { totalWeeks: 6 } }, token);

    let data = await req('GET', '/api/user/data', undefined, token);
    check('cycle stored with 6 weeks', data.body.cycle.totalWeeks, 6);
    check('starts on week 1', data.body.cycle.currentWeek, 1);
    check('phases shipped to the client', data.body.cycle.phases.length, 6);
    check('client gets labels, not just keys', data.body.cycle.phases[0].label, 'Base');

    const adv = await req('POST', '/api/cycle/advance', {}, token);
    check('advance succeeds', adv.status, 200);
    check('now on week 2', adv.body.cycle.currentWeek, 2);
    check('not complete yet', adv.body.completed, false);

    data = await req('GET', '/api/user/data', undefined, token);
    check('advance persisted', data.body.cycle.currentWeek, 2);

    // Walk to the end.
    for (let i = 0; i < 4; i++) await req('POST', '/api/cycle/advance', {}, token);
    data = await req('GET', '/api/user/data', undefined, token);
    check('reached the final week', data.body.cycle.currentWeek, 6);

    const done = await req('POST', '/api/cycle/advance', {}, token);
    check('advancing past the end completes the cycle', done.body.completed, true);
    check('no active cycle afterwards', done.body.cycle, null);

    const retired = await pg.query("SELECT status FROM cycles ORDER BY id DESC LIMIT 1");
    check('cycle marked completed, not abandoned', retired.rows[0].status, 'completed');

    const noCycle = await req('POST', '/api/cycle/advance', {}, token);
    check('advancing with no cycle is a clean 400', noCycle.status, 400);

    console.log('\n=== a cycle is never accidentally one week long ===\n');

    // The trap: Object.assign copies an undefined property straight over the default, so a
    // client that omitted totalWeeks produced a ONE WEEK cycle. Such a cycle is complete the
    // moment its first week is logged, with no next week to advance to -- permanently finished
    // on week 1 with no way forward.
    const noOpts = await req('POST', '/api/auth/register', { email: 'noopts@example.com', password: 'password1234' });
    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] }] }
    }, noOpts.body.token);
    let d = await req('GET', '/api/user/data', undefined, noOpts.body.token);
    check('omitting cycleOptions does not make a 1-week cycle', d.body.cycle.totalWeeks > 1, true);

    // An explicitly undefined totalWeeks is the exact shape the old client sent.
    const undef = await req('POST', '/api/auth/register', { email: 'undef@example.com', password: 'password1234' });
    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] }] },
        cycleOptions: { totalWeeks: undefined, goal: 'Strength' }
    }, undef.body.token);
    d = await req('GET', '/api/user/data', undefined, undef.body.token);
    check('undefined totalWeeks does not make a 1-week cycle', d.body.cycle.totalWeeks > 1, true);

    // The plan carries the length the server stamped on it; use it when the client forgets.
    const fromPlan = await req('POST', '/api/auth/register', { email: 'fromplan@example.com', password: 'password1234' });
    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', totalWeeks: 8, days: [{ dayName: 'A', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] }] }
    }, fromPlan.body.token);
    d = await req('GET', '/api/user/data', undefined, fromPlan.body.token);
    check('length falls back to the plan', d.body.cycle.totalWeeks, 8);

    console.log('\n=== an existing cycle can be lengthened ===\n');

    // The escape hatch for a cycle already stuck at one week.
    const stuck = await req('POST', '/api/auth/register', { email: 'stuck@example.com', password: 'password1234' });
    const stuckToken = stuck.body.token;
    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] }] },
        cycleOptions: { totalWeeks: 1 }
    }, stuckToken);
    d = await req('GET', '/api/user/data', undefined, stuckToken);
    check('a 1-week cycle can no longer even be created', d.body.cycle.totalWeeks >= cycles.MIN_WEEKS, true);

    // Reproduce the legacy state directly: rows written before the length picker existed are
    // already total_weeks = 1 in the database, and clamping on write cannot reach them.
    await pg.query("UPDATE cycles SET total_weeks = 1 WHERE id = $1", [d.body.cycle.id]);
    d = await req('GET', '/api/user/data', undefined, stuckToken);
    check('legacy 1-week cycle reads back as 1 week', d.body.cycle.totalWeeks, 1);
    check('and it reads as already complete', d.body.cycle.currentWeek >= d.body.cycle.totalWeeks, true);

    let len = await req('POST', '/api/cycle/length', { totalWeeks: 6 }, stuckToken);
    check('the cycle can be lengthened', len.status, 200);
    check('new length returned', len.body.cycle.totalWeeks, 6);
    check('phases recomputed for the new length', len.body.cycle.phases.length, 6);
    check('current week untouched', len.body.cycle.currentWeek, 1);

    d = await req('GET', '/api/user/data', undefined, stuckToken);
    check('the change persisted', d.body.cycle.totalWeeks, 6);
    check('there is now a week to advance to', d.body.cycle.currentWeek < d.body.cycle.totalWeeks, true);

    // Walk to week 4, then try to shorten below it.
    for (let i = 0; i < 3; i++) await req('POST', '/api/cycle/advance', {}, stuckToken);
    d = await req('GET', '/api/user/data', undefined, stuckToken);
    check('now on week 4', d.body.cycle.currentWeek, 4);

    const tooShort = await req('POST', '/api/cycle/length', { totalWeeks: 2 }, stuckToken);
    check('cannot shorten below the current week', tooShort.status, 400);
    check('and says why', /already on week 4/.test(tooShort.body.error), true);
    d = await req('GET', '/api/user/data', undefined, stuckToken);
    check('length unchanged after a rejected shorten', d.body.cycle.totalWeeks, 6);

    const shrinkToNow = await req('POST', '/api/cycle/length', { totalWeeks: 4 }, stuckToken);
    check('shortening to exactly the current week is allowed', shrinkToNow.status, 200);
    check('which completes the cycle', shrinkToNow.body.cycle.totalWeeks, 4);

    const absurd = await req('POST', '/api/cycle/length', { totalWeeks: 500 }, stuckToken);
    check('absurd lengths are clamped, not rejected', absurd.body.cycle.totalWeeks, cycles.MAX_WEEKS);

    const noCycleLen = await req('POST', '/api/cycle/length', { totalWeeks: 6 },
        (await req('POST', '/api/auth/register', { email: 'nocycle@example.com', password: 'password1234' })).body.token);
    check('no active cycle is a clean 400', noCycleLen.status, 400);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
