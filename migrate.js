// Minimal migration runner.
//
// The previous initDB() used CREATE TABLE IF NOT EXISTS, which cannot alter a table that
// already exists — so every schema change after the first was blocked unless the data was
// thrown away. That was survivable exactly once, while the developer was the only user.
// This exists so the next change does not need that excuse.
//
// Rules:
//   - Files are applied in filename order. Number them: 002_..., 003_...
//   - Each file runs inside a transaction and is recorded in schema_migrations.
//   - Applied files are never re-run, so never edit one after it has shipped. Write a new one.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Arbitrary but fixed: any process running migrations against this database takes the same
// lock, so concurrent runners serialise instead of racing.
const LOCK_KEY = 947213;

async function migrate(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id         TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // server.js starts initDB() without awaiting it, and more than one instance can boot at
    // once, so two runners can reach this point together. Without the lock both read the same
    // empty schema_migrations, both apply 001, and the loser dies on a duplicate key -- taking
    // the instance down with it. The lock is session-scoped and released in the finally below.
    return db.withClient(async client => {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        try {
            const appliedRows = await client.query('SELECT id FROM schema_migrations');
            const applied = new Set(appliedRows.rows.map(r => r.id));

            const files = fs.readdirSync(MIGRATIONS_DIR)
                .filter(f => f.endsWith('.sql'))
                .sort();

            const ran = [];

            for (const file of files) {
                if (applied.has(file)) continue;

                const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

                // One transaction per migration: a file that fails partway leaves nothing
                // behind, rather than a half-migrated schema the next run cannot reason about.
                await client.query('BEGIN');
                try {
                    await client.query(sql);
                    await client.query(
                        'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
                        [file]
                    );
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                }

                console.log('Applied migration:', file);
                ran.push(file);
            }

            if (ran.length === 0) {
                console.log('Database schema up to date (%d migrations applied).', applied.size);
            }
            return ran;
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
        }
    });
}

module.exports = { migrate, MIGRATIONS_DIR };
