/*
 * The injury guard: a programme for a lifter with a sore joint must not load that joint, even
 * when the model says "knee-safe" and adds step-ups anyway (seen in the AI sandbox).
 */
process.env.JWT_SECRET = 'injury-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_PROVIDER = 'claude';
process.env.AI_BURST_MAX = '999';
process.env.AI_DAILY_MAX = '999';
process.env.AUTH_MAX = '999';

const path = require('path');
const http = require('http');
const { stubAI } = require('./helpers/aistub');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const guard = require('../injuryGuard');
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
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

const ex = (name, role) => ({ name, role: role || 'main', repRange: '8-10', baseSets: 3 });
const programWith = lowerMoves => ({
    programName: 'Knee-Safe Block',
    rationale: 'Built around your knee.',
    progression: { rule: 'Add 5 lb when all reps are hit.', incrementUpper: 5, incrementLower: 10 },
    days: [
        { dayName: 'Upper', exercises: [ex('Dumbbell Bench Press'), ex('Dumbbell Row')] },
        { dayName: 'Lower', exercises: lowerMoves.map(n => ex(n)) }
    ],
    weeks: [1, 2, 3, 4].map(w => ({ week: w, phase: 'base', intent: 'build', setAdjustment: 0 }))
});

(async () => {
    console.log('\n=== spotting injuries and the moves that load them ===\n');

    const knee = guard.injuredJoints(['Left knee gets sore with lunges', 'Upper body felt strong']);
    check('a sore knee is noticed', knee.map(j => j.joint), ['knee']);
    check('no injury, no joints', guard.injuredJoints(['Felt great', null, undefined]).length, 0);
    check('shoulder and lower back are noticed too',
        guard.injuredJoints(['my shoulder clicks', 'lower back tight']).map(j => j.joint).sort(), ['lower back', 'shoulder']);

    const plan = programWith(['Dumbbell Romanian Deadlift', 'Dumbbell Step-Up', 'Reverse Lunge', 'Glute Bridge']);
    check('step-ups and lunges are flagged for a knee',
        guard.offendingMovements(plan, knee).map(o => o.name), ['Dumbbell Step-Up', 'Reverse Lunge']);
    check('nothing flagged without an injury', guard.offendingMovements(plan, []).length, 0);

    const removed = guard.removeOffending(plan, knee);
    check('removal drops only the offending moves', removed, ['Dumbbell Step-Up', 'Reverse Lunge']);
    check('the rest of the day stays', plan.days[1].exercises.map(e => e.name), ['Dumbbell Romanian Deadlift', 'Glute Bridge']);

    const onlyBad = programWith(['Walking Lunge']);
    check('a day is never emptied', guard.removeOffending(onlyBad, knee).length, 0);

    console.log('\n=== end to end: the route asks again, then removes ===\n');

    installPgShim();
    const ai = require(path.join(ROOT, 'aiClient.js'));
    let answers = [];
    const calls = stubAI(ai, async () => JSON.stringify(answers.length > 1 ? answers.shift() : answers[0]));

    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => { PORT = this.address().port; if (typeof cb === 'function') cb(); resolve(); });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;
    await require(path.join(ROOT, 'migrate.js')).migrate(require(path.join(ROOT, 'db.js')));

    const token = (await req('POST', '/api/auth/register', { email: 'knee@example.com', password: 'password1234' })).body.token;
    const body = { primaryGoal: 'Hypertrophy', experienceLevel: 'Intermediate', trainingDays: 2, totalWeeks: 4, extraDetails: 'Left knee is sore.' };

    answers = [programWith(['Dumbbell Step-Up', 'Glute Bridge']), programWith(['Hip Thrust', 'Glute Bridge'])];
    calls.length = 0;
    let r = await req('POST', '/api/generate-program', body, token);
    check('programme created', r.status, 200);
    check('the model was asked a second time', calls.length, 2);
    check('the second ask names the offending move', /Dumbbell Step-Up/.test(calls[1].prompt), true);
    check('the saved programme is the clean one', r.body.program.days[1].exercises.map(e => e.name), ['Hip Thrust', 'Glute Bridge']);

    answers = [programWith(['Dumbbell Step-Up', 'Glute Bridge'])];
    calls.length = 0;
    r = await req('POST', '/api/generate-program', body, token);
    check('still created when the model repeats itself', r.status, 200);
    check('the step-up is removed as a last resort', r.body.program.days[1].exercises.map(e => e.name), ['Glute Bridge']);

    answers = [programWith(['Dumbbell Step-Up', 'Glute Bridge'])];
    calls.length = 0;
    r = await req('POST', '/api/generate-program', Object.assign({}, body, { extraDetails: 'No injuries.' }), token);
    check('no injury: one call, nothing changed', [calls.length, r.body.program.days[1].exercises.length], [1, 2]);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
