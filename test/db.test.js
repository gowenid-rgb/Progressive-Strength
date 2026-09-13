/*
 * Database tests for T1-4 — user_data persistence and registration atomicity.
 *
 * Runs against a real PostgreSQL (PGlite, Postgres compiled to WASM) so the SQL is
 * genuinely executed rather than eyeballed. No Docker or local server needed.
 *
 * Assertions read result.rowCount specifically, because that is the property server.js
 * checks. PGlite exposes both rowCount and affectedRows; node-postgres exposes rowCount.
 *
 * Both the schema and the upsert statement are READ OUT OF THE SOURCE FILES rather than
 * copied here, so this test cannot silently drift from what the app actually runs.
 *
 * The bug under test: POST /api/user/data used UPDATE, which affects zero rows when the
 * user_data row is missing and returned {success:true} regardless — silently discarding
 * the user's plan and entire workout history.
 */
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

/* Pull the real schema out of db.js rather than restating it. */
function extractSchema() {
    const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    const m = src.match(/await pool\.query\(`([\s\S]*?)`\)/);
    if (!m) throw new Error('could not extract schema from db.js');
    return m[1];
}

/* Pull the real upsert statement out of server.js rather than restating it. */
function extractUpsert() {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const m = src.match(/`(INSERT INTO user_data[\s\S]*?)`/);
    if (!m) throw new Error('could not extract upsert SQL from server.js');
    return m[1];
}

/* Load the real db.js with `pg` swapped for a PGlite-backed pool, so withTransaction
 * itself is exercised rather than reimplemented. */
function loadRealDb(pglite) {
    const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    const client = {
        query: (text, params) => pglite.query(text, params),
        release: () => {}
    };
    const FakePool = function () {};
    FakePool.prototype.query = (text, params) => pglite.query(text, params);
    FakePool.prototype.connect = async () => client;

    const fakeRequire = name => (name === 'pg' ? { Pool: FakePool } : require(name));
    const factory = new Function('require', 'module', 'exports', 'process', src);
    const mod = { exports: {} };
    factory(fakeRequire, mod, mod.exports, { env: { DATABASE_URL: 'postgres://test/test' } });
    return mod.exports;
}

(async () => {
    console.log('\n=== T1-4: user_data persistence ===\n');

    const pg = new PGlite();
    await pg.exec(extractSchema());
    const db = loadRealDb(pg);
    const UPSERT = extractUpsert();

    const u = await pg.query(
        "INSERT INTO users (email, password_hash) VALUES ('a@x.com','h') RETURNING id"
    );
    const userId = u.rows[0].id;

    // Reproduce the original bug for the record: no user_data row exists yet, and the old
    // UPDATE reports zero rows changed while the handler still returned success.
    await pg.query('DELETE FROM user_data WHERE user_id = $1', [userId]);
    const oldWay = await pg.query(
        'UPDATE user_data SET current_plan = $1, workout_journal = $2 WHERE user_id = $3',
        [JSON.stringify({ planName: 'X' }), JSON.stringify([{ d: 1 }]), userId]
    );
    check('OLD CODE: UPDATE on a missing row silently wrote nothing', oldWay.rowCount, 0);

    // The fix: upsert creates the row instead of dropping the data.
    const plan = { planName: 'Base Cycle', days: [{ dayName: 'Push', completed: true }] };
    const journal = [{ date: '2026-09-01', exercises: [{ name: 'Squat', sets: [{ weight: '225', reps: '5' }] }] }];

    let r = await db.query(UPSERT, [userId, JSON.stringify(plan), JSON.stringify(journal)]);
    check('upsert on MISSING row reports 1 row', r.rowCount, 1);

    let read = await pg.query('SELECT current_plan, workout_journal FROM user_data WHERE user_id = $1', [userId]);
    check('row was actually created', read.rows.length, 1);
    check('plan round-trips through JSONB', read.rows[0].current_plan.planName, 'Base Cycle');
    check('nested completed flag survives', read.rows[0].current_plan.days[0].completed, true);
    check('journal round-trips', read.rows[0].workout_journal[0].exercises[0].sets[0].weight, '225');

    // Second save on the now-existing row must update, not duplicate or error.
    const plan2 = { planName: 'Peak Cycle', days: [] };
    r = await db.query(UPSERT, [userId, JSON.stringify(plan2), JSON.stringify([])]);
    check('upsert on EXISTING row reports 1 row', r.rowCount, 1);

    read = await pg.query('SELECT current_plan, workout_journal FROM user_data WHERE user_id = $1', [userId]);
    check('still exactly one row (no duplicate)', read.rows.length, 1);
    check('plan was overwritten', read.rows[0].current_plan.planName, 'Peak Cycle');
    check('journal was overwritten', read.rows[0].workout_journal, []);

    // A null plan (user hit Reset) must persist as null, not crash.
    r = await db.query(UPSERT, [userId, null, JSON.stringify([])]);
    read = await pg.query('SELECT current_plan FROM user_data WHERE user_id = $1', [userId]);
    check('null plan persists as null', read.rows[0].current_plan, null);

    // A save for a user that does not exist must fail loudly, not half-write.
    let fkError = null;
    try {
        await db.query(UPSERT, [999999, JSON.stringify(plan), JSON.stringify([])]);
    } catch (e) { fkError = e.message; }
    check('save for a nonexistent user is rejected', fkError !== null, true);

    console.log('\n=== T1-4: registration atomicity ===\n');

    // Success path: both rows land together.
    const created = await db.withTransaction(async client => {
        const ins = await client.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
            ['b@x.com', 'hash']
        );
        await client.query('INSERT INTO user_data (user_id) VALUES ($1)', [ins.rows[0].id]);
        return ins.rows[0];
    });
    let cnt = await pg.query('SELECT COUNT(*)::int AS n FROM user_data WHERE user_id = $1', [created.id]);
    check('commit creates the user_data row', cnt.rows[0].n, 1);

    // Failure path: if the second insert fails, the users row must not survive.
    let rolledBack = false;
    try {
        await db.withTransaction(async client => {
            await client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', ['c@x.com', 'hash']);
            throw new Error('simulated failure on second insert');
        });
    } catch (e) { rolledBack = true; }
    check('transaction threw to the caller', rolledBack, true);

    const orphan = await pg.query("SELECT COUNT(*)::int AS n FROM users WHERE email = 'c@x.com'");
    check('ROLLBACK left no orphaned users row', orphan.rows[0].n, 0);

    // Duplicate email must surface as 23505 so the route can return a clean 400.
    let code = null;
    try {
        await pg.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', ['b@x.com', 'hash2']);
    } catch (e) { code = e.code; }
    check('duplicate email raises unique_violation 23505', code, '23505');

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
