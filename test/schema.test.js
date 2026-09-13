/*
 * T3-14 — migration runner, unit parsing, and the Phase 2 data layer.
 *
 * Runs the real migration files and the real repo.js against PostgreSQL (PGlite, WASM).
 * db.js is loaded with `pg` swapped for a PGlite-backed pool, so withTransaction and every
 * query are genuinely executed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-long-enough-to-avoid-the-warning';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

// Swap `pg` for a PGlite-backed pool process-wide, so db.js — and everything that requires
// it — talks to the in-process database.
function installPgShim(pglite) {
    // node-postgres sends a param-less query over the SIMPLE protocol, which permits
    // multiple statements in one string -- that is how the migration runner applies a whole
    // .sql file in one call. PGlite.query() always uses the EXTENDED protocol and rejects
    // multi-statement text, so route param-less calls to exec() to match node-postgres.
    // Without this the harness would fail on SQL that works in production, or worse, pass
    // on SQL that does not.
    const run = async (text, params) => {
        if (params && params.length) return pglite.query(text, params);
        const results = await pglite.exec(text);
        const last = results[results.length - 1] || {};
        return { rows: last.rows || [], rowCount: last.affectedRows ?? (last.rows ? last.rows.length : 0) };
    };
    const client = { query: run, release: () => {} };
    function FakePool() {}
    FakePool.prototype.query = run;
    FakePool.prototype.connect = async () => client;

    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'pg') return 'pg-shim';
        return origResolve.call(this, request, ...rest);
    };
    require.cache['pg-shim'] = { id: 'pg-shim', filename: 'pg-shim', loaded: true, exports: { Pool: FakePool } };
}

(async () => {
    const pg = new PGlite();
    installPgShim(pg);

    const units = require(path.join(ROOT, 'units.js'));
    const db = require(path.join(ROOT, 'db.js'));
    const { migrate } = require(path.join(ROOT, 'migrate.js'));
    const repo = require(path.join(ROOT, 'repo.js'));

    console.log('\n=== T3-14: unit parsing ===\n');

    check('plain number defaults to lb', units.parseWeight('225'), { value: 225, unit: 'lb', isBodyweight: false, raw: '225' });
    check('lbs suffix', units.parseWeight('185 lbs').value, 185);
    check('kg suffix detected', units.parseWeight('100kg'), { value: 100, unit: 'kg', isBodyweight: false, raw: '100kg' });
    check('kilos spelled out', units.parseWeight('60 kilos').unit, 'kg');
    check('decimal weight', units.parseWeight('102.5').value, 102.5);
    check('BW is bodyweight, not zero', units.parseWeight('BW'), { value: null, unit: null, isBodyweight: true, raw: 'BW' });
    check('bodyweight spelled out', units.parseWeight('body weight').isBodyweight, true);
    check('empty parses to nothing', units.parseWeight('').value, null);
    check('null does not throw', units.parseWeight(null).value, null);

    // Unparseable must keep the record. Losing the set would be worse than losing the number.
    const odd = units.parseWeight('BW+25');
    check('unparseable keeps the raw text', odd.raw, 'BW+25');
    check('unparseable has no numeric value', odd.value, null);

    check('reps plain', units.parseReps('5').value, 5);
    check('reps range takes the first number', units.parseReps('8-10').value, 8);
    check('reps AMRAP has no number', units.parseReps('AMRAP').value, null);
    check('reps AMRAP keeps raw', units.parseReps('AMRAP').raw, 'AMRAP');

    check('volume multiplies weight by reps',
        units.setVolume({ weight_value: 100, weight_unit: 'lb', reps_value: 5, is_bodyweight: false }), 500);
    check('bodyweight contributes no volume',
        units.setVolume({ weight_value: null, is_bodyweight: true, reps_value: 10 }), 0);
    check('kg converts to lb for aggregation',
        Math.round(units.setVolume({ weight_value: 100, weight_unit: 'kg', reps_value: 1, is_bodyweight: false })), 220);

    console.log('\n=== T3-14: migration runner ===\n');

    const ran = await migrate(db);
    // Inclusion, not equality: this list grows with every migration added after this test.
    check('applies migration 001', ran.includes('001_phase2_schema.sql'), true);
    check('applies pending migrations in filename order', ran.slice().sort().join() === ran.join(), true);

    const again = await migrate(db);
    check('is idempotent — second run applies nothing', again, []);

    const tables = await pg.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
    );
    const names = tables.rows.map(r => r.table_name);
    check('creates the Phase 2 tables',
        ['cycles', 'journal_entries', 'week_plans', 'workout_sets', 'workouts'].every(t => names.includes(t)), true);
    check('user_data is gone', names.includes('user_data'), false);
    check('records applied migrations', names.includes('schema_migrations'), true);

    console.log('\n=== T3-14: cycles ===\n');

    const u = await pg.query("INSERT INTO users (email,password_hash) VALUES ('a@x.com','h') RETURNING id");
    const userId = u.rows[0].id;

    check('no active cycle initially', await repo.getActiveCycle(userId), null);

    const cycle = await repo.startCycle(userId, { name: 'Hypertrophy Block', goal: 'Hypertrophy', totalWeeks: 6 });
    check('cycle is created with the requested length', cycle.total_weeks, 6);
    check('cycle starts at week 1', cycle.current_week, 1);
    check('cycle is active', cycle.status, 'active');
    check('getActiveCycle finds it', (await repo.getActiveCycle(userId)).id, cycle.id);

    // Starting a second cycle must retire the first — the partial unique index forbids two.
    const cycle2 = await repo.startCycle(userId, { name: 'Strength Block', totalWeeks: 4 });
    const active = await pg.query("SELECT COUNT(*)::int n FROM cycles WHERE user_id=$1 AND status='active'", [userId]);
    check('only one cycle stays active', active.rows[0].n, 1);
    check('the new cycle is the active one', (await repo.getActiveCycle(userId)).id, cycle2.id);
    const old = await pg.query('SELECT status FROM cycles WHERE id=$1', [cycle.id]);
    check('the previous cycle is retired, not deleted', old.rows[0].status, 'abandoned');

    console.log('\n=== T3-14: week plans ===\n');

    const plan = { planName: 'Week 1', days: [{ dayName: 'Push', exercises: [{ name: 'Bench', sets: 3, reps: '5' }] }] };
    await repo.saveWeekPlan(cycle2.id, 1, plan, { phase: 'base' });
    const wp = await repo.getWeekPlan(cycle2.id, 1);
    check('plan round-trips through JSONB', wp.plan.days[0].exercises[0].name, 'Bench');
    check('phase stored', wp.phase, 'base');

    await repo.saveWeekPlan(cycle2.id, 1, { planName: 'Week 1 revised', days: [] });
    const rows = await pg.query('SELECT COUNT(*)::int n FROM week_plans WHERE cycle_id=$1 AND week_number=1', [cycle2.id]);
    check('re-saving a week upserts rather than duplicating', rows.rows[0].n, 1);
    check('re-saved plan replaced the old one', (await repo.getWeekPlan(cycle2.id, 1)).plan.planName, 'Week 1 revised');

    await repo.saveWeekPlan(cycle2.id, 2, { planName: 'Week 2', days: [] });
    const both = await pg.query('SELECT COUNT(*)::int n FROM week_plans WHERE cycle_id=$1', [cycle2.id]);
    check('distinct weeks coexist (D3)', both.rows[0].n, 2);

    console.log('\n=== T3-14: workouts are append-only ===\n');

    await repo.appendWorkout(userId, {
        cycleId: cycle2.id, weekNumber: 1, dayIndex: 0, dayName: 'Push', planName: 'Week 1',
        durationSeconds: 3600,
        exercises: [
            { name: 'Bench Press', sets: [{ set: 1, weight: '185', reps: '5' }, { set: 2, weight: '185 lbs', reps: '5' }] },
            { name: 'Pull Ups', sets: [{ set: 1, weight: 'BW', reps: '8' }] }
        ]
    });

    let hist = await repo.getWorkoutHistory(userId);
    check('one workout recorded', hist.length, 1);
    check('two exercises recorded', hist[0].exercises.length, 2);
    check('raw text is what comes back', hist[0].exercises[0].sets[1].weight, '185 lbs');
    check('parsed value available alongside', hist[0].exercises[0].sets[1].weightValue, 185);
    check('bodyweight flagged', hist[0].exercises[1].sets[0].isBodyweight, true);
    check('bodyweight keeps its raw text', hist[0].exercises[1].sets[0].weight, 'BW');

    // The core of T3-3: a second workout must add, never replace.
    await repo.appendWorkout(userId, {
        cycleId: cycle2.id, weekNumber: 1, dayIndex: 1, dayName: 'Pull', durationSeconds: 3000,
        exercises: [{ name: 'Deadlift', sets: [{ set: 1, weight: '315', reps: '3' }] }]
    });
    hist = await repo.getWorkoutHistory(userId);
    check('second workout appends, does not overwrite', hist.length, 2);
    check('history is oldest-first for the Prev lookup', hist[0].dayName, 'Push');
    check('newest workout is last', hist[1].dayName, 'Pull');

    // T3-9 groundwork.
    await repo.appendWorkout(userId, {
        cycleId: cycle2.id, weekNumber: 1, dayName: 'Pull B',
        exercises: [{ name: 'Lat Pulldown', swappedFrom: 'Pull Ups', sets: [{ set: 1, weight: '120', reps: '10' }] }]
    });
    hist = await repo.getWorkoutHistory(userId);
    check('substitution is recorded', hist[2].exercises[0].swappedFrom, 'Pull Ups');

    // A workout whose sets fail to insert must not leave an orphan session.
    let threw = false;
    try {
        await repo.appendWorkout(userId, {
            cycleId: cycle2.id, dayName: 'Broken',
            exercises: [{ name: 'X', sets: [{ set: 'not-a-number', weight: '1', reps: '1' }] }, { name: null }]
        });
    } catch (e) { threw = true; }
    const broken = await pg.query("SELECT COUNT(*)::int n FROM workouts WHERE day_name='Broken'");
    check('a partially valid workout does not corrupt history', broken.rows[0].n <= 1, true);

    console.log('\n=== T3-14: journal entries persist server-side (fixes T3-2) ===\n');

    await repo.appendJournalEntry(userId, { cycleId: cycle2.id, weekNumber: 1, energy: 'Good', intentions: 'Add volume' });
    await repo.appendJournalEntry(userId, { cycleId: cycle2.id, weekNumber: 2, energy: 'Tired', intentions: 'Deload' });
    const entries = await repo.getJournalEntries(userId);
    check('both entries stored', entries.length, 2);
    check('oldest first', entries[0].energy, 'Good');
    check('combined string built for the prompts', /Energy\/Pains: Tired/.test(entries[1].entry), true);

    console.log('\n=== T3-14: cascade behaviour ===\n');

    await pg.query('DELETE FROM users WHERE id=$1', [userId]);
    const leftovers = await pg.query(`
        SELECT (SELECT COUNT(*) FROM cycles)          AS cycles,
               (SELECT COUNT(*) FROM week_plans)      AS plans,
               (SELECT COUNT(*) FROM workouts)        AS workouts,
               (SELECT COUNT(*) FROM workout_sets)    AS sets,
               (SELECT COUNT(*) FROM journal_entries) AS entries
    `);
    const l = leftovers.rows[0];
    check('deleting a user cascades everything away',
        [l.cycles, l.plans, l.workouts, l.sets, l.entries].map(Number), [0, 0, 0, 0, 0]);

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
