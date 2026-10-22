// Sets a new password for one existing account. Changes ONLY users.password_hash for that
// email: the account id stays the same, so workouts, cycles, journal and metrics are untouched.
//
// Usage (PowerShell), pointing at the database you want to change:
//   $env:DATABASE_URL = "<the Postgres connection string from Railway>"
//   $env:NEW_PASSWORD = "<the new password>"
//   node scripts/reset-password.js you@example.com
//
// The connection string and password are read from the environment so they never appear in a
// file, in shell history as a literal argument, or in chat. Use Railway's PUBLIC connection
// string (DATABASE_PUBLIC_URL); the internal one only works inside Railway.
const bcrypt = require('bcrypt');

async function resetPassword(db, email, newPassword) {
    if (!email) throw new Error('An email address is required.');
    if (!newPassword || newPassword.length < 8) throw new Error('Choose a password of at least 8 characters.');
    const found = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (found.rows.length === 0) throw new Error('No account found for ' + email + '.');
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [found.rows[0].id, hash]);
    return found.rows[0].id;
}

module.exports = { resetPassword };

if (require.main === module) {
    require('dotenv').config();
    (async () => {
        const email = process.argv[2];
        if (!process.env.DATABASE_URL) {
            console.error('Set DATABASE_URL first (see the comment at the top of this file).');
            process.exit(1);
        }
        const { Pool } = require('pg');
        const url = process.env.DATABASE_URL;
        const pool = new Pool({
            connectionString: url,
            ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }
        });
        try {
            const id = await resetPassword(pool, email, process.env.NEW_PASSWORD);
            console.log('Password updated for account #' + id + '. Log in with the new password; your data is unchanged.');
        } catch (err) {
            console.error(err.message);
            process.exitCode = 1;
        } finally {
            await pool.end();
        }
    })();
}
