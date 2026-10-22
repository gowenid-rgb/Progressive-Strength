/*
 * scripts/reset-password.js: changes the password and nothing else.
 */
process.env.JWT_SECRET = 'reset-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';

const path = require('path');
const bcrypt = require('bcrypt');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

(async () => {
    installPgShim();
    const db = require(path.join(ROOT, 'db.js'));
    await require(path.join(ROOT, 'migrate.js')).migrate(db);
    const { resetPassword } = require(path.join(ROOT, 'scripts', 'reset-password.js'));

    const hash = await bcrypt.hash('old-password-1', 10);
    const u = await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', ['me@example.com', hash]);
    const id = u.rows[0].id;
    await db.query(`INSERT INTO workouts (user_id, day_name, finished_at) VALUES ($1, 'Day 1', now())`, [id]);

    const before = (await db.query('SELECT id, email, created_at FROM users WHERE id = $1', [id])).rows[0];
    const returned = await resetPassword(db, 'me@example.com', 'brand-new-password');
    const after = (await db.query('SELECT id, email, password_hash, created_at FROM users WHERE id = $1', [id])).rows[0];

    check('the same account is updated', returned, id);
    check('the new password works', await bcrypt.compare('brand-new-password', after.password_hash), true);
    check('the old password no longer works', await bcrypt.compare('old-password-1', after.password_hash), false);
    check('the account id, email and date are unchanged', [after.id, after.email, after.created_at], [before.id, before.email, before.created_at]);
    check('logged workouts are untouched', Number((await db.query('SELECT COUNT(*) AS n FROM workouts WHERE user_id = $1', [id])).rows[0].n), 1);

    let message = '';
    try { await resetPassword(db, 'nobody@example.com', 'brand-new-password'); } catch (e) { message = e.message; }
    check('an unknown email is refused', /No account found/.test(message), true);
    message = '';
    try { await resetPassword(db, 'me@example.com', 'short'); } catch (e) { message = e.message; }
    check('a too-short password is refused', /at least 8/.test(message), true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
