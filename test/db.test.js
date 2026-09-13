/*
 * Registration atomicity (from T1-4), against the Phase 2 schema.
 *
 * HISTORY: this file originally covered the `user_data` upsert — the fix for a bug where
 * UPDATE against a missing row affected zero rows and still reported success, silently
 * discarding a user's plan and history. `T3-14` removed the `user_data` table entirely and
 * replaced blob-overwrite saves with append-only workouts, so that fix and its assertions
 * are obsolete rather than regressed. `test/schema.test.js` now covers persistence.
 *
 * What remains valid, and still matters: a users row must never exist without the rest of
 * its records landing too. That was the state which made the original bug reachable.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-long-enough-to-avoid-the-warning';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';

const path = require('path');
const { installPgShim, makeChecker } = require('./helpers/pgshim');

const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

(async () => {
    const pg = installPgShim();

    const db = require(path.join(ROOT, 'db.js'));
    const { migrate } = require(path.join(ROOT, 'migrate.js'));
    await migrate(db);

    console.log('\n=== Registration atomicity ===\n');

    // Success path: the transaction commits and the user exists.
    const created = await db.withTransaction(async client => {
        const ins = await client.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
            ['b@x.com', 'hash']
        );
        // Phase 2 has no user_data row to create; a cycle is created later, when the user
        // actually generates a plan. Registration now only needs to create the user.
        return ins.rows[0];
    });
    let cnt = await pg.query('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [created.id]);
    check('commit creates the user', cnt.rows[0].n, 1);

    // Failure path: anything that throws mid-transaction must leave nothing behind.
    let rolledBack = false;
    try {
        await db.withTransaction(async client => {
            await client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', ['c@x.com', 'hash']);
            throw new Error('simulated failure after the first insert');
        });
    } catch (e) { rolledBack = true; }
    check('transaction threw to the caller', rolledBack, true);

    const orphan = await pg.query("SELECT COUNT(*)::int AS n FROM users WHERE email = 'c@x.com'");
    check('ROLLBACK left no orphaned users row', orphan.rows[0].n, 0);

    // Duplicate email must surface as 23505 so the route returns a clean 400 rather than a
    // 500, and without a racy SELECT-then-INSERT.
    let code = null;
    try {
        await pg.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', ['b@x.com', 'hash2']);
    } catch (e) { code = e.code; }
    check('duplicate email raises unique_violation 23505', code, '23505');

    // A cycle started inside a failed transaction must not survive either — this is the
    // Phase 2 equivalent of the orphan case above.
    const u2 = await pg.query("INSERT INTO users (email,password_hash) VALUES ('d@x.com','h') RETURNING id");
    let cycleRolledBack = false;
    try {
        await db.withTransaction(async client => {
            await client.query(
                "INSERT INTO cycles (user_id, name, total_weeks, status) VALUES ($1,'Doomed',6,'active')",
                [u2.rows[0].id]
            );
            throw new Error('simulated failure after creating the cycle');
        });
    } catch (e) { cycleRolledBack = true; }
    check('a failed cycle creation rolls back', cycleRolledBack, true);
    const doomed = await pg.query("SELECT COUNT(*)::int AS n FROM cycles WHERE name = 'Doomed'");
    check('no orphaned cycle left behind', doomed.rows[0].n, 0);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
