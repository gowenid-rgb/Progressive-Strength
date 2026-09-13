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

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
