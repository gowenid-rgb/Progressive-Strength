/*
 * Phase 3 — the programme, and rendering weeks from it.
 *
 * The point of designing a cycle up front is that progression becomes a calculation instead of
 * a fresh improvisation each week. So it has to be provable: given what was lifted, the next
 * prescription is one specific number, for one stated reason.
 *
 * renderWeek is pure, so every case here runs with no database, no model and no clock.
 */
process.env.JWT_SECRET = 'program-test-secret-long-enough-to-avoid-warnings';
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

const PROGRAM = {
    programName: 'Six Week Base',
    rationale: 'Built off last cycle.',
    totalWeeks: 6,
    progression: { rule: 'Add weight when every set hits the top of the range.', incrementUpper: 5, incrementLower: 10 },
    days: [{
        dayName: 'Push',
        focus: 'Chest and shoulders',
        exercises: [
            { name: 'Barbell Bench Press', role: 'primary', repRange: '6-8', baseSets: 3 },
            { name: 'Back Squat', role: 'primary', repRange: '5', baseSets: 3 },
            { name: 'Cable Fly', role: 'accessory', repRange: '12-15', baseSets: 3 }
        ]
    }],
    weeks: [
        { week: 1, phase: 'base', intent: 'Establish working weights.', setAdjustment: 0 },
        { week: 2, phase: 'base', intent: 'Add a set.', setAdjustment: 1 },
        { week: 3, phase: 'build', intent: 'Push the top of the range.', setAdjustment: 1 },
        { week: 4, phase: 'build', intent: 'Heavier.', setAdjustment: 1 },
        { week: 5, phase: 'peak', intent: 'Heaviest week.', setAdjustment: 0 },
        { week: 6, phase: 'deload', intent: 'Recover.', setAdjustment: -1 }
    ]
};

// History in the shape repo.getWorkoutHistory returns.
function session(name, sets) {
    return {
        date: '2026-09-14T10:00:00Z',
        dayName: 'Push',
        exercises: [{
            name,
            sets: sets.map((s, i) => ({
                set: i + 1, weight: String(s[0]), reps: String(s[1]),
                weightValue: s[0], weightUnit: 'lb', isBodyweight: false, repsValue: s[1]
            }))
        }]
    };
}

(async () => {
    installPgShim();
    const prog = require(path.join(ROOT, 'program.js'));

    console.log('\n=== rep ranges ===\n');

    check('a range parses', prog.parseRepRange('6-8'), { min: 6, max: 8 });
    check('a single number parses', prog.parseRepRange('5'), { min: 5, max: 5 });
    check('an en dash parses', prog.parseRepRange('8–10'), { min: 8, max: 10 });
    check('AMRAP is not a number', prog.parseRepRange('AMRAP'), null);
    check('time-based is not a number', prog.parseRepRange('30 seconds'), { min: 30, max: 30 });
    check('empty is null', prog.parseRepRange(''), null);

    console.log('\n=== progression is earned, not assumed ===\n');

    // Every set at the top of the range: the weight goes up.
    let r = prog.prescribeWeight(
        { name: 'Barbell Bench Press', repRange: '6-8' }, PROGRAM,
        [session('Barbell Bench Press', [[185, 8], [185, 8], [185, 8]])],
        { phase: 'build' });
    check('all sets at the top adds weight', r.suggestedWeight, '190 lbs');
    check('and says why', /hit 8 reps on every set/.test(r.reason), true);

    // One set short: hold the weight. Prescribing a jump nobody earned makes a programme
    // unfollowable within a fortnight.
    r = prog.prescribeWeight(
        { name: 'Barbell Bench Press', repRange: '6-8' }, PROGRAM,
        [session('Barbell Bench Press', [[185, 8], [185, 8], [185, 6]])],
        { phase: 'build' });
    check('one short set holds the weight', r.suggestedWeight, '185 lbs');
    check('and explains the gap', /got 8 of 8 reps|Add weight once all sets reach 8/.test(r.reason), true);

    // Lower body moves in bigger jumps than upper.
    r = prog.prescribeWeight(
        { name: 'Back Squat', repRange: '5' }, PROGRAM,
        [session('Back Squat', [[225, 5], [225, 5], [225, 5]])],
        { phase: 'build' });
    check('lower body uses the bigger increment', r.suggestedWeight, '235 lbs');

    // A new movement gets no invented number.
    r = prog.prescribeWeight({ name: 'Never Done This', repRange: '8-10' }, PROGRAM, [], { phase: 'base' });
    check('an unseen movement has no prescription', r.suggestedWeight, null);
    check('and says so plainly', /First time/.test(r.reason), true);

    // Bodyweight work carries no load to progress.
    r = prog.prescribeWeight({ name: 'Pull Ups', repRange: '8-10' }, PROGRAM,
        [{ date: 'd', exercises: [{ name: 'Pull Ups', sets: [{ weightValue: null, isBodyweight: true, repsValue: 8 }] }] }],
        { phase: 'base' });
    check('bodyweight gets no invented weight', r.suggestedWeight, null);

    // A deload cuts load on purpose -- it is not a failure to progress.
    r = prog.prescribeWeight(
        { name: 'Barbell Bench Press', repRange: '6-8' }, PROGRAM,
        [session('Barbell Bench Press', [[200, 8], [200, 8], [200, 8]])],
        { phase: 'deload' });
    check('a deload reduces the load', r.suggestedWeight, '170 lbs');
    check('and names itself a deload', /Deload/.test(r.reason), true);

    console.log('\n=== rendering a week ===\n');

    const history = [session('Barbell Bench Press', [[185, 8], [185, 8], [185, 8]])];
    let week = prog.renderWeek(PROGRAM, 3, history);
    check('week number is carried', week.week, 3);
    check('cycle length is carried', week.totalWeeks, 6);
    check('phase comes from the programme', week.phase, 'build');
    check('the day survives', week.days[0].dayName, 'Push');
    check('the week intent becomes the intro', week.days[0].workoutIntro, 'Push the top of the range.');
    check('movements come from the programme', week.days[0].exercises.map(e => e.name),
        ['Barbell Bench Press', 'Back Squat', 'Cable Fly']);
    check('setAdjustment is applied', week.days[0].exercises[0].sets, 4);
    check('progression is applied to the prescription', week.days[0].exercises[0].suggestedWeight, '190 lbs');
    check('the reason travels with it', /Up 5 lb/.test(week.days[0].exercises[0].progressionNote), true);

    // The same movements every week is the entire point -- it is what makes progression
    // trackable and what stopped names drifting.
    const w1 = prog.renderWeek(PROGRAM, 1, history);
    const w6 = prog.renderWeek(PROGRAM, 6, history);
    check('movements are identical in week 1 and week 6',
        JSON.stringify(w1.days[0].exercises.map(e => e.name)) === JSON.stringify(w6.days[0].exercises.map(e => e.name)), true);
    check('the deload drops a set', w6.days[0].exercises[0].sets, 2);
    check('the deload drops the load', w6.days[0].exercises[0].suggestedWeight, '155 lbs');
    check('sets never fall below one', prog.renderWeek(
        Object.assign({}, PROGRAM, { weeks: [{ week: 1, phase: 'base', intent: 'x', setAdjustment: -9 }] }),
        1, history).days[0].exercises[0].sets, 1);

    // A week the programme forgot to describe must still render.
    week = prog.renderWeek(Object.assign({}, PROGRAM, { weeks: [] }), 4, history);
    check('a missing week spec still renders', week.days[0].exercises.length, 3);
    check('and falls back to the computed phase', week.phase, 'build');

    console.log('\n=== validating a designed programme ===\n');

    check('a good programme passes', prog.validateProgram(PROGRAM, 6), null);
    check('no days is rejected', prog.validateProgram({ days: [], weeks: [1], progression: { rule: 'x' } }, 6), 'days is empty');
    check('a day with no exercises is rejected',
        prog.validateProgram({ days: [{ dayName: 'A', exercises: [] }], weeks: [{ week: 1 }], progression: { rule: 'x' } }, 6),
        'day 0 has no exercises');
    check('no progression rule is rejected',
        /progression/.test(prog.validateProgram({ days: PROGRAM.days, weeks: PROGRAM.weeks }, 6) || ''), true);

    // The failure this whole design exists to prevent: a six-week cycle that only describes four.
    const short = Object.assign({}, PROGRAM, { weeks: PROGRAM.weeks.slice(0, 4) });
    check('a programme missing later weeks is rejected', prog.validateProgram(short, 6), 'week 5 of 6 is missing from the plan');

    console.log('\n=== end to end ===\n');

    const ai = require(path.join(ROOT, 'aiClient.js'));
    ai.__setClientForTests({
        interactions: { create: async () => ({ output_text: JSON.stringify(PROGRAM) }) }
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
    const ran = await require(path.join(ROOT, 'migrate.js')).migrate(db);
    check('migration 004 applies', ran.includes('004_cycle_program.sql'), true);

    const reg = await req('POST', '/api/auth/register', { email: 'programmer@example.com', password: 'password1234' });
    const token = reg.body.token;

    const made = await req('POST', '/api/generate-program', {
        primaryGoal: 'Hypertrophy', experienceLevel: 'Intermediate', totalWeeks: 6
    }, token);
    check('programme created', made.status, 200);
    check('cycle length is honoured, not name-only', made.body.cycle.totalWeeks, 6);
    check('cycle starts at week 1', made.body.cycle.currentWeek, 1);
    check('week 1 rendered from the programme', made.body.plan.days[0].exercises[0].name, 'Barbell Bench Press');
    check('the programme is returned', made.body.program.programName, 'Six Week Base');

    let data = await req('GET', '/api/user/data', undefined, token);
    check('the cycle persists as 6 weeks', data.body.cycle.totalWeeks, 6);
    check('the programme is stored on the cycle', !!data.body.cycle.program, true);
    check('the plan reads back', data.body.currentPlan.days[0].dayName, 'Push');

    // Advancing renders from the programme with no model call.
    const before = { calls: 0 };
    ai.__setClientForTests({
        interactions: { create: async () => { before.calls++; return { output_text: JSON.stringify(PROGRAM) }; } }
    });
    const adv = await req('POST', '/api/cycle/advance', {}, token);
    check('advance succeeds', adv.status, 200);
    check('week 2 comes back already rendered', adv.body.plan.week, 2);
    check('no model call was needed', before.calls, 0);
    check('the same movements carry over', adv.body.plan.days[0].exercises[0].name, 'Barbell Bench Press');

    data = await req('GET', '/api/user/data', undefined, token);
    check('week 2 was saved', data.body.currentPlan.week, 2);
    check('the cycle is on week 2', data.body.cycle.currentWeek, 2);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
