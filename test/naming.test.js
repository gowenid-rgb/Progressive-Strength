/*
 * Movement-name stability across generated weeks.
 *
 * Each week is a separate model call, so asked cold the model writes "Deadlift" one week and
 * "Barbell Deadlift" the next. Grouped by name in any aggregate, one climbing lift then reads
 * as two unrelated one-session movements — which is what "the progression graphs aren't
 * working" turned out to be.
 *
 * The prompt is the fix, so these assertions inspect THE ACTUAL PROMPT SENT. A previous round
 * shipped this guidance with no test, and it went to only one of the two generation paths —
 * recalibrating a plan could still rename every lift in it, silently.
 */
process.env.JWT_SECRET = 'naming-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.GEMINI_API_KEY = 'test-key-not-used';
process.env.AI_BURST_MAX = '999';
process.env.AUTH_MAX = '999';

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
    installPgShim();

    // Capture every prompt and answer with a valid plan, so the endpoints run to completion.
    const prompts = [];
    const ai = require(path.join(ROOT, 'aiClient.js'));
    const reply = JSON.stringify({
        planName: 'Week', week: 1,
        days: [{ dayName: 'Pull', exercises: [{ name: 'Deadlift', sets: 3, reps: '5' }] }]
    });
    ai.__setClientForTests({
        interactions: {
            create: async r => { prompts.push(r.input); return { output_text: reply }; }
        }
    });

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

    const reg = await req('POST', '/api/auth/register', { email: 'namer@example.com', password: 'password1234' });
    const token = reg.body.token;

    console.log('\n=== a first plan has nothing to anchor to ===\n');

    prompts.length = 0;
    await req('POST', '/api/generate-plan', { primaryGoal: 'Strength', totalWeeks: 6 }, token);
    check('generate-plan was reached', prompts.length, 1);
    check('no naming block when there is no history', /MOVEMENT NAMES ALREADY IN USE/.test(prompts[0]), false);

    // Establish a plan and some logged history.
    const plan = {
        planName: 'Six Week Block',
        days: [
            { dayName: 'Pull', exercises: [{ name: 'Barbell Deadlift', sets: 3, reps: '5' }] },
            { dayName: 'Push', exercises: [{ name: 'Barbell Bench Press', sets: 3, reps: '5' }] }
        ]
    };
    await req('POST', '/api/user/data', { currentPlan: plan, cycleOptions: { totalWeeks: 6 } }, token);
    await req('POST', '/api/workouts', {
        dayName: 'Pull',
        exercises: [{ name: 'Barbell Deadlift', sets: [{ set: 1, weight: '185', reps: '5' }] }]
    }, token);

    console.log('\n=== generating the next week reuses the names ===\n');

    prompts.length = 0;
    await req('POST', '/api/generate-plan', { primaryGoal: 'Strength' }, token);
    const gen = prompts[0];
    check('naming block present', /MOVEMENT NAMES ALREADY IN USE/.test(gen), true);
    check('a logged movement is listed', /- Barbell Deadlift/.test(gen), true);
    check('a planned but unlogged movement is also listed', /- Barbell Bench Press/.test(gen), true);
    check('the instruction is explicit about exactness', /character[\s\S]{0,20}for character/.test(gen), true);
    check('the failure mode is spelled out', /must not become/.test(gen), true);
    check('new movements are still allowed', /Only invent a new name/.test(gen), true);

    console.log('\n=== recalibrating must not rename the plan it is editing ===\n');

    // This was the gap: the naming guidance reached generate-plan only, so every "Adjust
    // Program" request could quietly rename every lift in the plan.
    prompts.length = 0;
    await req('POST', '/api/recalibrate-plan', {
        currentPlan: plan, feedback: 'My back is sore, go easier on hinging.'
    }, token);
    check('recalibrate-plan was reached', prompts.length, 1);
    const rec = prompts[0];
    check('naming block present on recalibrate too', /MOVEMENT NAMES ALREADY IN USE/.test(rec), true);
    check('names from the plan being edited are listed', /- Barbell Bench Press/.test(rec), true);
    check('logged history is listed as well', /- Barbell Deadlift/.test(rec), true);

    console.log('\n=== the list is deduplicated ===\n');

    // "Barbell Deadlift" is both logged and in the plan; it must appear once, or the list
    // grows a duplicate every week and eats the context window.
    const occurrences = (rec.match(/- Barbell Deadlift\n/g) || []).length;
    check('a name in both history and plan appears once', occurrences, 1);

    console.log('\n=== recalibrating before anything is logged still anchors ===\n');

    const solo = await req('POST', '/api/auth/register', { email: 'fresh@example.com', password: 'password1234' });
    prompts.length = 0;
    await req('POST', '/api/recalibrate-plan', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Front Squat', sets: 3, reps: '5' }] }] },
        feedback: 'swap the accessory'
    }, solo.body.token);
    const fresh = prompts[0];
    check('plan names anchor even with empty history', /- Front Squat/.test(fresh), true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
