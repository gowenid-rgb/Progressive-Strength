// Local test mode. When LOCAL_DB=1 the app swaps `pg` for a file-backed PGlite database
// (real PostgreSQL compiled to WASM), so the whole app can be clicked through on a laptop
// with no Postgres install. Data lives in .devdata/ and survives restarts.
// Never active on Railway: it only runs when LOCAL_DB=1 is set, and Railway does not set it.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const DATA_DIR = path.join(__dirname, '..', '.devdata', 'pg');
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpass123';

function install() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const pglite = new PGlite(DATA_DIR);

    // Same trick as test/helpers/pgshim.js: param-less queries must use exec() so the
    // migration runner can send a whole .sql file in one call, as real pg does.
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
    require.cache['pg-shim'] = {
        id: 'pg-shim', filename: 'pg-shim', loaded: true, exports: { Pool: FakePool }
    };

    // server.js only initialises the database when DATABASE_URL is set.
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'pglite://local';

    seedTestAccount(run).catch(err => console.error('Test account seed failed:', err.message));
    console.log('[local-db] Using file-backed PGlite in .devdata/. Test login: ' + TEST_EMAIL + ' / ' + TEST_PASSWORD);
}

// The server runs migrations on its own, un-awaited. Wait until all of them are recorded,
// then make sure the test account exists.
async function seedTestAccount(run) {
    const total = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter(f => f.endsWith('.sql')).length;
    for (let i = 0; i < 100; i++) {
        try {
            const r = await run('SELECT count(*)::int AS n FROM schema_migrations');
            if (r.rows[0].n >= total) break;
        } catch (e) { /* table not created yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    await run('INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [TEST_EMAIL, hash]);
}

module.exports = { install };
