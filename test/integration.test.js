/*
 * T3-14 end-to-end: the real Express app, over real HTTP, against real PostgreSQL.
 *
 * The unit suites verify repo.js and the schema in isolation. This one exists to catch
 * wiring mistakes between them — a handler reading the wrong field, an endpoint that never
 * got mounted, a response shape the client cannot consume. It registers a user, saves a
 * plan, logs workouts and reads it all back the way the browser would.
 *
 * No Gemini key needed: nothing here touches the AI routes.
 */
process.env.JWT_SECRET = 'integration-secret-long-enough-to-avoid-the-warning';
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
            let data = '';
            res.on('data', d => { data += d; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
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

    // server.js calls app.listen itself; intercept to bind an ephemeral port.
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

    // server.js kicks off initDB() without awaiting; wait for migrations to land.
    const db = require(path.join(ROOT, 'db.js'));
    await require(path.join(ROOT, 'migrate.js')).migrate(db);

    console.log('\n=== T3-14 integration: registration ===\n');

    const reg = await req('POST', '/api/auth/register', { email: 'lifter@example.com', password: 'hunter2hunter2' });
    check('register succeeds', reg.status, 201);
    check('register returns a token', typeof reg.body.token, 'string');
    const token = reg.body.token;

    const dup = await req('POST', '/api/auth/register', { email: 'lifter@example.com', password: 'other' });
    check('duplicate email is a clean 400', dup.status, 400);
    check('duplicate email is not a 500', dup.body.error, 'User already exists');

    const login = await req('POST', '/api/auth/login', { email: 'lifter@example.com', password: 'hunter2hunter2' });
    check('login succeeds', login.status, 200);

    console.log('\n=== T3-14 integration: a new user has nothing ===\n');

    let data = await req('GET', '/api/user/data', undefined, token);
    check('fetch succeeds', data.status, 200);
    check('no plan yet', data.body.currentPlan, null);
    check('no history yet', data.body.workoutJournal, []);
    check('no cycle yet', data.body.cycle, null);

    console.log('\n=== T3-14 integration: saving a plan creates a cycle ===\n');

    const plan = {
        planName: 'Six Week Hypertrophy',
        days: [
            { dayName: 'Push', exercises: [{ name: 'Bench Press', sets: 3, reps: '5' }] },
            { dayName: 'Pull', exercises: [{ name: 'Pull Ups', sets: 3, reps: '8' }] }
        ]
    };
    const save = await req('POST', '/api/user/data', { currentPlan: plan, cycleOptions: { totalWeeks: 6, goal: 'Hypertrophy' } }, token);
    check('plan save succeeds', save.status, 200);
    check('a cycle was created', typeof save.body.cycle.id, 'number');
    check('cycle length honoured', save.body.cycle.totalWeeks, 6);

    data = await req('GET', '/api/user/data', undefined, token);
    check('plan reads back', data.body.currentPlan.planName, 'Six Week Hypertrophy');
    check('plan structure intact', data.body.currentPlan.days[1].exercises[0].name, 'Pull Ups');
    check('cycle reported to the client', data.body.cycle.currentWeek, 1);

    // Saving again must update the same cycle, not start a second one.
    await req('POST', '/api/user/data', { currentPlan: Object.assign({}, plan, { planName: 'Revised' }) }, token);
    const cycleCount = await pg.query("SELECT COUNT(*)::int n FROM cycles WHERE status='active'");
    check('re-saving does not create a second cycle', cycleCount.rows[0].n, 1);
    data = await req('GET', '/api/user/data', undefined, token);
    check('revised plan reads back', data.body.currentPlan.planName, 'Revised');

    console.log('\n=== T3-14 integration: workouts append ===\n');

    const w1 = await req('POST', '/api/workouts', {
        planName: 'Revised', dayName: 'Push', dayIndex: 0, durationSeconds: 3600,
        exercises: [{ name: 'Bench Press', sets: [{ set: 1, weight: '185', reps: '5' }, { set: 2, weight: '185', reps: '5' }] }]
    }, token);
    check('workout accepted', w1.status, 201);

    await req('POST', '/api/workouts', {
        planName: 'Revised', dayName: 'Pull', dayIndex: 1, durationSeconds: 3000,
        exercises: [{ name: 'Lat Pulldown', swappedFrom: 'Pull Ups', sets: [{ set: 1, weight: 'BW', reps: '10' }] }]
    }, token);

    data = await req('GET', '/api/user/data', undefined, token);
    check('both workouts present', data.body.workoutJournal.length, 2);
    check('history is oldest-first', data.body.workoutJournal[0].dayName, 'Push');
    check('raw weight preserved for display', data.body.workoutJournal[0].exercises[0].sets[0].weight, '185');
    check('parsed value available for metrics', data.body.workoutJournal[0].exercises[0].sets[0].weightValue, 185);
    check('bodyweight flagged', data.body.workoutJournal[1].exercises[0].sets[0].isBodyweight, true);
    check('substitution recorded', data.body.workoutJournal[1].exercises[0].swappedFrom, 'Pull Ups');

    // The whole point of append-only: saving the plan again must not touch history.
    await req('POST', '/api/user/data', { currentPlan: plan }, token);
    data = await req('GET', '/api/user/data', undefined, token);
    check('saving the plan does not disturb history', data.body.workoutJournal.length, 2);

    const empty = await req('POST', '/api/workouts', { dayName: 'Nothing', exercises: [] }, token);
    check('an empty workout is rejected', empty.status, 400);

    console.log('\n=== T3-14 integration: journal entries persist (T3-2) ===\n');

    const j = await req('POST', '/api/journal', { energy: 'Strong all week', intentions: 'Push volume' }, token);
    check('journal entry accepted', j.status, 201);

    const blank = await req('POST', '/api/journal', { energy: '   ', intentions: '' }, token);
    check('empty journal entry rejected', blank.status, 400);

    data = await req('GET', '/api/user/data', undefined, token);
    check('entry returned to the client', data.body.journalEntries.length, 1);
    check('entry content intact', data.body.journalEntries[0].energy, 'Strong all week');

    console.log('\n=== T3-14 integration: reset retires the cycle but keeps history ===\n');

    const reset = await req('POST', '/api/user/data', { currentPlan: null }, token);
    check('reset accepted', reset.status, 200);
    check('no active cycle after reset', reset.body.cycle, null);

    data = await req('GET', '/api/user/data', undefined, token);
    check('plan is gone', data.body.currentPlan, null);
    check('history survives a reset', data.body.workoutJournal.length, 2);

    const retired = await pg.query("SELECT status FROM cycles ORDER BY id DESC LIMIT 1");
    check('the cycle is retired, not deleted', retired.rows[0].status, 'abandoned');

    console.log('\n=== T3-14 integration: isolation between users ===\n');

    const other = await req('POST', '/api/auth/register', { email: 'other@example.com', password: 'password1234' });
    const otherData = await req('GET', '/api/user/data', undefined, other.body.token);
    check('a second user sees no history', otherData.body.workoutJournal, []);
    check('a second user sees no plan', otherData.body.currentPlan, null);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
