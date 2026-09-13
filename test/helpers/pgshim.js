// Swaps `pg` for a PGlite-backed pool so tests exercise the real db.js, repo.js and
// migration files against real PostgreSQL (WASM) with no Docker and no server.
//
// The protocol detail matters: node-postgres sends a param-less query over the SIMPLE
// protocol, which permits several statements in one string — that is how the migration
// runner applies a whole .sql file in a single call. PGlite.query() always uses the
// EXTENDED protocol and rejects multi-statement text. Routing param-less calls to exec()
// makes the harness behave like production. Without it, tests would fail on SQL that works
// in production — or pass on SQL that does not.
const Module = require('module');
const { PGlite } = require('@electric-sql/pglite');

function installPgShim() {
    const pglite = new PGlite();

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

    return pglite;
}

function makeChecker() {
    const state = { pass: 0, fail: 0 };
    const check = (label, actual, expected) => {
        const a = JSON.stringify(actual), e = JSON.stringify(expected);
        if (a === e) { console.log('  PASS  ' + label); state.pass++; }
        else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); state.fail++; }
    };
    const report = () => {
        console.log('\n' + (state.fail === 0 ? 'ALL PASS' : 'FAILURES') +
            ': ' + state.pass + ' passed, ' + state.fail + ' failed\n');
        process.exit(state.fail === 0 ? 0 : 1);
    };
    return { check, report, state };
}

module.exports = { installPgShim, makeChecker };
