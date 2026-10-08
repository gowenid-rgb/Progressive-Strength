/*
 * Correcting logged history, and never logging a session twice.
 *
 * Run against real Postgres. The cases that matter are the ones that would quietly lose or
 * invent training data: the same session saved twice, a stale device re-uploading a session the
 * lifter deleted, someone else's workout reached by guessing an id, an edit that does not reach
 * the Metrics tab, and a correction that destroys instead of corrects.
 */
process.env.JWT_SECRET = 'history-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

const path = require('path');
const fs = require('fs');
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
            let d = ''; res.on('data', c => { d += c; });
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject); if (payload) r.write(payload); r.end();
    });
}

(async () => {
    installPgShim();
    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => { PORT = this.address().port; if (typeof cb === 'function') cb(); resolve(); });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;
    const db = require(path.join(ROOT, 'db.js'));
    const ran = await require(path.join(ROOT, 'migrate.js')).migrate(db);
    check('migration 007 applies', ran.includes('007_history_corrections.sql'), true);

    const reg = await req('POST', '/api/auth/register', { email: 'editor@example.com', password: 'password1234' });
    const token = reg.body.token;
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).id;
    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Weighted Pull-Up', sets: 4, reps: '4-6' }] }] },
        cycleOptions: { totalWeeks: 6 }
    }, token);

    const log = (extra) => req('POST', '/api/workouts', Object.assign({
        dayName: 'Day 1', dayIndex: 0, durationSeconds: 3000, weekNumber: 1,
        exercises: [{ name: 'Weighted Pull-Up', sets: [6, 5, 5, 4].map((r, i) => ({ set: i + 1, weight: '35', reps: String(r) })) }]
    }, extra), token);
    const list = async () => (await req('GET', '/api/workouts', undefined, token)).body;
    const count = async (sql, params) => Number((await db.query(sql, params || [])).rows[0].n);

    console.log('\n=== the same session is never saved twice ===\n');
    let r = await log({ clientId: 'abc-1', date: '2026-09-21T18:00:00.000Z' });
    check('first save is created', [r.status, r.body.duplicate], [201, false]);
    const firstId = r.body.workoutId;
    r = await log({ clientId: 'abc-1', date: '2026-09-21T18:00:00.000Z' });
    check('the same clientId is recognised', [r.status, r.body.duplicate, r.body.workoutId], [200, true, firstId]);
    check('and nothing is added', await count('SELECT COUNT(*) AS n FROM workouts WHERE user_id = $1', [userId]), 1);
    check('nor any sets', await count('SELECT COUNT(*) AS n FROM workout_sets'), 4);

    r = await log({ date: '2026-09-24T18:00:00.000Z' });
    check('an older app (no clientId) is saved normally the first time', [r.status, r.body.duplicate], [201, false]);
    r = await log({ date: '2026-09-24T18:00:00.000Z' });
    check('and recognised by its timestamp the second', [r.status, r.body.duplicate], [200, true]);
    r = await log({ date: '2026-09-22T18:00:00.000Z' });
    check('a genuinely different session is saved', [r.status, r.body.duplicate], [201, false]);
    check('a save with no date and no id still works', (await log({ date: undefined })).status, 201);

    const burst = await Promise.all(Array.from({ length: 6 }, () => log({ clientId: 'race-1', date: '2026-09-23T18:00:00.000Z' })));
    check('six identical requests at once create exactly one session', await count("SELECT COUNT(*) AS n FROM workouts WHERE client_id = 'race-1'"), 1);
    check('and all six succeed', burst.every(x => x.status === 200 || x.status === 201), true);

    // The in-memory database handles one query at a time, so the six requests above never truly
    // overlap. The safety net for a REAL race is the unique index, so exercise it directly: make the
    // "have we seen this?" check miss, as it would for two requests that arrive together, and prove
    // the index still stops the second copy and returns the first.
    const repo = require(path.join(ROOT, 'repo.js'));
    const realQuery = db.query;
    let missed = false;
    db.query = async (sql, params) => {
        if (!missed && /FROM workouts WHERE user_id = \$1 AND client_id = \$2/.test(sql)) { missed = true; return { rows: [] }; }
        return realQuery.call(db, sql, params);
    };
    let raced;
    try {
        raced = await repo.appendWorkout(userId, { clientId: 'race-1', date: '2026-09-23T18:00:00.000Z', weekNumber: 1, dayName: 'Day 1', exercises: [{ name: 'Weighted Pull-Up', sets: [{ set: 1, weight: '35', reps: '6' }] }] });
    } finally { db.query = realQuery; }
    check('the pre-check missed, as in a real race', missed, true);
    check('the unique index still prevented a second copy and returned the first', [raced.duplicate, await count("SELECT COUNT(*) AS n FROM workouts WHERE client_id = 'race-1'")], [true, 1]);

    console.log('\n=== existing sessions get an id, and duplicates are kept for review ===\n');
    await db.query(`INSERT INTO workouts (user_id, cycle_id, week_number, day_name, finished_at) VALUES ($1, NULL, 1, 'Dup Day', '2026-08-01T10:00:00.123Z'), ($1, NULL, 1, 'Dup Day', '2026-08-01T10:00:00.123Z')`, [userId]);
    await db.query(`UPDATE workouts SET client_id = NULL WHERE day_name = 'Dup Day'`);
    let backfillError = null;
    try { await db.query(fs.readFileSync(path.join(ROOT, 'migrations', '007_history_corrections.sql'), 'utf8')); } catch (e) { backfillError = e.message; }
    check('re-running the migration is safe, even with identical timestamps', backfillError, null);
    const dups = (await db.query(`SELECT client_id FROM workouts WHERE day_name = 'Dup Day' ORDER BY id`)).rows.map(x => x.client_id);
    check('the first gets the id the app derives from its timestamp', dups[0], 'legacy:2026-08-01T10:00:00.123Z');
    check('the second is kept, with a suffix', /^legacy:2026-08-01T10:00:00\.123Z#\d+$/.test(dups[1]), true);
    check('so a device re-uploading that session is recognised', (await log({ date: '2026-08-01T10:00:00.123Z', dayName: 'Dup Day' })).body.duplicate, true);
    await db.query(`UPDATE workouts SET deleted_at = now() WHERE day_name = 'Dup Day'`);

    console.log('\n=== reading the history ===\n');
    let l = await list();
    check('requires auth', (await req('GET', '/api/workouts')).status, 401);
    check('lists the sessions', l.workouts.length >= 3, true);
    const w1 = l.workouts.find(w => w.id === firstId);
    check('each set has an id', w1.exercises[0].sets.every(s => Number.isInteger(s.id)), true);
    check('with the day and week', [w1.dayName, w1.weekNumber], ['Day 1', 1]);
    check('and the values as logged', w1.exercises[0].sets.map(s => s.reps), ['6', '5', '5', '4']);
    check('the cycle is included, for choosing a week', l.cycle.totalWeeks, 6);

    await db.query(`INSERT INTO workouts (user_id, cycle_id, week_number, day_name, finished_at, client_id) SELECT user_id, cycle_id, week_number, day_name, finished_at, 'twin' FROM workouts WHERE id = $1`, [firstId]);
    l = await list();
    const twin = l.workouts.find(w => w.id !== firstId && w.dayName === 'Day 1' && w.date === w1.date);
    check('two sessions at the same instant on the same day are flagged as a possible duplicate', twin.possibleDuplicateOf, firstId);
    check('the first of them is not', l.workouts.find(w => w.id === firstId).possibleDuplicateOf, null);
    await db.query('UPDATE workouts SET deleted_at = now() WHERE id = $1', [twin.id]);

    console.log('\n=== editing a set ===\n');
    const setId = w1.exercises[0].sets[1].id;           // the 5
    const url = `/api/workouts/${firstId}/sets/${setId}`;
    check('requires auth', (await req('PATCH', url, { weight: '35', reps: '7' })).status, 401);
    check('rejects non-numeric reps', (await req('PATCH', url, { weight: '35', reps: 'lots' }, token)).status, 400);
    check('rejects an unreadable weight', (await req('PATCH', url, { weight: 'heavy', reps: '7' }, token)).status, 400);
    check('rejects an absurd rep count', (await req('PATCH', url, { weight: '35', reps: '5000' }, token)).status, 400);
    check('a rejected edit changed nothing', (await list()).workouts.find(w => w.id === firstId).exercises[0].sets[1].reps, '5');

    r = await req('PATCH', url, { weight: '40', reps: '7' }, token);
    check('a valid edit is accepted', r.status, 200);
    const edited = (await list()).workouts.find(w => w.id === firstId).exercises[0].sets[1];
    check('and shows the new values', [edited.weight, edited.reps], ['40', '7']);
    check('and is marked as edited', edited.edited, true);
    const row = (await db.query('SELECT weight_value, reps_value, weight_unit FROM workout_sets WHERE id = $1', [setId])).rows[0];
    check('the parsed numbers are updated too, not just the text', [Number(row.weight_value), row.reps_value, row.weight_unit], [40, 7, 'lb']);
    const audit = (await db.query(`SELECT before, after FROM workout_edits WHERE set_id = $1 AND action = 'edit_set'`, [setId])).rows[0];
    check('the old values are kept in the audit trail', [audit.before.reps, audit.after.reps], ['5', '7']);

    check('blank weight means bodyweight', (await req('PATCH', url, { weight: '', reps: '7' }, token)).status, 200);
    check('stored as bodyweight', (await db.query('SELECT is_bodyweight AS b FROM workout_sets WHERE id = $1', [setId])).rows[0].b, true);
    check('kilograms are understood', (await req('PATCH', url, { weight: '20 kg', reps: '7' }, token)).status, 200);
    await req('PATCH', url, { weight: '35', reps: '5' }, token);

    console.log('\n=== the edit reaches the Metrics tab ===\n');
    await log({ clientId: 'wk2', date: '2026-09-28T18:00:00.000Z', weekNumber: 2, exercises: [{ name: 'Weighted Pull-Up', sets: [6, 6, 5, 4].map((x, i) => ({ set: i + 1, weight: '35', reps: String(x) })) }] });
    let m = (await req('GET', '/api/metrics', undefined, token)).body.cycle.movements.find(x => x.name === 'Weighted Pull-Up');
    check('week 2 compares with week 1', m.weeks[1].delta.kind, 'reps');
    await req('PATCH', url, { weight: '35', reps: '9' }, token);
    m = (await req('GET', '/api/metrics', undefined, token)).body.cycle.movements.find(x => x.name === 'Weighted Pull-Up');
    check('correcting week 1 changes what week 2 is compared against (24 reps then, 21 now)', [m.weeks[1].delta.kind, m.weeks[1].delta.amount], ['down', -3]);
    await req('PATCH', url, { weight: '35', reps: '5' }, token);

    console.log('\n=== deleting a set ===\n');
    const lastId = w1.exercises[0].sets[3].id;
    r = await req('DELETE', `/api/workouts/${firstId}/sets/${lastId}`, undefined, token);
    check('accepted', [r.status, r.body.workoutRemoved], [200, false]);
    check('gone from the history', (await list()).workouts.find(w => w.id === firstId).exercises[0].sets.length, 3);
    const sessionIn = body => body.cycle.movements.find(x => x.name === 'Weighted Pull-Up').weeks[0].sessions.find(s => s.workoutId === firstId);
    check('gone from the Metrics tab', sessionIn((await req('GET', '/api/metrics', undefined, token)).body).sets.length, 3);
    check('gone from what the AI reads', (await req('GET', '/api/user/data', undefined, token)).body.workoutJournal.find(w => w.id === firstId).exercises[0].sets.length, 3);
    check('but the row is kept', await count('SELECT COUNT(*) AS n FROM workout_sets WHERE id = $1 AND deleted_at IS NOT NULL', [lastId]), 1);
    check('and recorded', await count(`SELECT COUNT(*) AS n FROM workout_edits WHERE set_id = $1 AND action = 'delete_set'`, [lastId]), 1);
    check('deleting it again is "not found"', (await req('DELETE', `/api/workouts/${firstId}/sets/${lastId}`, undefined, token)).status, 404);
    check('editing a deleted set is "not found"', (await req('PATCH', `/api/workouts/${firstId}/sets/${lastId}`, { weight: '35', reps: '5' }, token)).status, 404);

    console.log('\n=== adding a set ===\n');
    r = await req('POST', `/api/workouts/${firstId}/sets`, { exercise: 'Weighted Pull-Up', weight: '35', reps: '4' }, token);
    check('accepted', r.status, 200);
    const afterAdd = (await list()).workouts.find(w => w.id === firstId).exercises[0].sets;
    check('appended after the last set', afterAdd.map(s => s.set), [1, 2, 3, 5]);
    check('with a valid id', Number.isInteger(r.body.id), true);
    check('a movement not in the session is refused', (await req('POST', `/api/workouts/${firstId}/sets`, { exercise: 'Curls', weight: '20', reps: '10' }, token)).status, 404);
    check('bad reps are refused', (await req('POST', `/api/workouts/${firstId}/sets`, { exercise: 'Weighted Pull-Up', weight: '35', reps: 'x' }, token)).status, 400);

    console.log('\n=== renaming a movement ===\n');
    check('requires a name', (await req('PATCH', `/api/workouts/${firstId}/exercise`, { from: 'Weighted Pull-Up', to: '  ' }, token)).status, 400);
    check('an unknown movement is "not found"', (await req('PATCH', `/api/workouts/${firstId}/exercise`, { from: 'Nope', to: 'X' }, token)).status, 404);
    check('works', (await req('PATCH', `/api/workouts/${firstId}/exercise`, { from: 'Weighted Pull-Up', to: 'Pull-Up (Weighted)' }, token)).status, 200);
    check('shows in the history', (await list()).workouts.find(w => w.id === firstId).exercises[0].name, 'Pull-Up (Weighted)');
    await req('PATCH', `/api/workouts/${firstId}/exercise`, { from: 'Pull-Up (Weighted)', to: 'Weighted Pull-Up' }, token);

    console.log('\n=== moving a session to another week ===\n');
    check('a week past the end of the cycle is refused', (await req('PATCH', `/api/workouts/${firstId}`, { weekNumber: 9 }, token)).status, 400);
    check('so is a non-number', (await req('PATCH', `/api/workouts/${firstId}`, { weekNumber: 'two' }, token)).status, 400);
    check('moving works', (await req('PATCH', `/api/workouts/${firstId}`, { weekNumber: 3 }, token)).status, 200);
    m = (await req('GET', '/api/metrics', undefined, token)).body.cycle.movements.find(x => x.name === 'Weighted Pull-Up');
    check('and the scorecard follows: it is in week 3 now', m.weeks[2].sessions.some(s => s.workoutId === firstId), true);
    check('and no longer in week 1', m.weeks[0].sessions.some(s => s.workoutId === firstId), false);
    await req('PATCH', `/api/workouts/${firstId}`, { weekNumber: 1 }, token);

    // A session saved with no active cycle belongs to nothing and shows nowhere.
    const orphan = (await db.query(`INSERT INTO workouts (user_id, cycle_id, week_number, day_name, finished_at, client_id) VALUES ($1, NULL, NULL, 'Orphan', now(), 'orphan') RETURNING id`, [userId])).rows[0].id;
    await db.query(`INSERT INTO workout_sets (workout_id, exercise_name, exercise_order, set_number, weight_value, weight_unit, is_bodyweight, reps_value, weight_raw, reps_raw) VALUES ($1, 'Flat Dumbbell Bench Press', 0, 1, 50, 'lb', false, 10, '50', '10')`, [orphan]);
    m = (await req('GET', '/api/metrics', undefined, token)).body.cycle;
    check('a session attached to no cycle is not on the scorecard', m.movements.some(x => x.name === 'Flat Dumbbell Bench Press'), false);
    check('but the Metrics tab says so, instead of hiding it', m.unplaced.map(x => x.name), ['Flat Dumbbell Bench Press']);
    check('moving it into a week attaches it to the active cycle', (await req('PATCH', `/api/workouts/${orphan}`, { weekNumber: 2 }, token)).status, 200);
    m = (await req('GET', '/api/metrics', undefined, token)).body.cycle;
    check('and it now appears', m.movements.some(x => x.name === 'Flat Dumbbell Bench Press'), true);
    check('with nothing left unplaced', m.unplaced, []);

    console.log('\n=== deleting a session ===\n');
    const victim = (await log({ clientId: 'victim', date: '2026-10-01T18:00:00.000Z', weekNumber: 2 })).body.workoutId;
    check('deleting works', (await req('DELETE', `/api/workouts/${victim}`, undefined, token)).status, 200);
    check('it leaves the history', (await list()).workouts.some(w => w.id === victim), false);
    check('and what the AI reads', (await req('GET', '/api/user/data', undefined, token)).body.workoutJournal.some(w => w.id === victim), false);
    check('and the list of movements it is told to keep naming consistently', await count("SELECT COUNT(*) AS n FROM workouts w JOIN workout_sets s ON s.workout_id = w.id WHERE w.id = $1 AND w.deleted_at IS NULL", [victim]), 0);
    check('and its sets are not counted', await count('SELECT COUNT(*) AS n FROM workout_sets WHERE workout_id = $1 AND deleted_at IS NULL', [victim]), 0);
    check('but nothing is destroyed', await count('SELECT COUNT(*) AS n FROM workout_sets WHERE workout_id = $1', [victim]), 4);
    r = await log({ clientId: 'victim', date: '2026-10-01T18:00:00.000Z', weekNumber: 2 });
    check('a stale device re-uploading it does NOT bring it back', [r.body.duplicate, (await list()).workouts.some(w => w.id === victim)], [true, false]);
    check('deleting twice is "not found"', (await req('DELETE', `/api/workouts/${victim}`, undefined, token)).status, 404);

    const lone = (await log({ clientId: 'lone', date: '2026-10-02T18:00:00.000Z', weekNumber: 2, exercises: [{ name: 'Curls', sets: [{ set: 1, weight: '20', reps: '10' }] }] })).body.workoutId;
    const loneSet = (await list()).workouts.find(w => w.id === lone).exercises[0].sets[0].id;
    r = await req('DELETE', `/api/workouts/${lone}/sets/${loneSet}`, undefined, token);
    check('removing the last set removes the session', [r.body.workoutRemoved, (await list()).workouts.some(w => w.id === lone)], [true, false]);

    console.log('\n=== other people\'s data ===\n');
    const other = await req('POST', '/api/auth/register', { email: 'other-editor@example.com', password: 'password1234' });
    const ot = other.body.token;
    check('they see none of it', (await req('GET', '/api/workouts', undefined, ot)).body.workouts, []);
    check('cannot edit a set', (await req('PATCH', url, { weight: '1', reps: '1' }, ot)).status, 404);
    check('cannot delete a set', (await req('DELETE', url, undefined, ot)).status, 404);
    check('cannot add a set', (await req('POST', `/api/workouts/${firstId}/sets`, { exercise: 'Weighted Pull-Up', weight: '1', reps: '1' }, ot)).status, 404);
    check('cannot move a session', (await req('PATCH', `/api/workouts/${firstId}`, { weekNumber: 2 }, ot)).status, 404);
    check('cannot rename a movement', (await req('PATCH', `/api/workouts/${firstId}/exercise`, { from: 'Weighted Pull-Up', to: 'X' }, ot)).status, 404);
    check('cannot delete a session', (await req('DELETE', `/api/workouts/${firstId}`, undefined, ot)).status, 404);
    check('and none of that changed anything', (await list()).workouts.find(w => w.id === firstId).exercises[0].sets.length, 4);
    check('garbage ids are a clean 400', (await req('DELETE', '/api/workouts/abc', undefined, token)).status, 400);
    check('so are negative ones', (await req('PATCH', '/api/workouts/-1/sets/-2', { weight: '1', reps: '1' }, token)).status, 400);
    check('an id that does not exist is 404, not a crash', (await req('DELETE', '/api/workouts/999999', undefined, token)).status, 404);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
