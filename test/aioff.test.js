/*
 * AI is off unless AI_PROVIDER=claude, and the Windows Claude program guard.
 */
process.env.JWT_SECRET = 'aioff-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AUTH_MAX = '1000';
process.env.AI_BURST_MAX = '1000';
process.env.AI_DAILY_MAX = '1000';
delete process.env.AI_PROVIDER;

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const { stubAI } = require('./helpers/aistub');
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
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

const OFF = 'AI features are off on this server (set AI_PROVIDER=claude on a machine signed in to Claude).';

(async () => {
    installPgShim();
    const ai = require(path.join(ROOT, 'aiClient.js'));
    let modelCalls = 0;
    stubAI(ai, async () => { modelCalls++; return '{"weeks":6,"rationale":"x","phases":[]}'; });

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
    await require(path.join(ROOT, 'migrate.js')).migrate(db);

    const reg = await req('POST', '/api/auth/register', { email: 'aioff@example.com', password: 'password1234' });
    const token = reg.body.token;

    console.log('\n=== AI_PROVIDER unset ===\n');
    const routes = [
        '/api/recommend-cycle-length', '/api/generate-program', '/api/generate-plan',
        '/api/recalibrate-plan', '/api/weekly-review', '/api/generate-recap'
    ];
    for (const r of routes) {
        const res = await req('POST', r, { currentPlan: { days: [] }, feedback: 'x' }, token);
        check(r + ' says AI is off', [res.status, res.body.error], [500, OFF]);
    }
    check('no model call was spent', modelCalls, 0);
    check('the rest of the app is unaffected', (await req('GET', '/api/user/data', undefined, token)).status, 200);
    check('the old Gemini model-listing route is gone', (await req('GET', '/api/models', undefined, token)).status, 404);

    console.log('\n=== AI_PROVIDER=claude ===\n');
    process.env.AI_PROVIDER = 'claude';
    const on = await req('POST', '/api/recommend-cycle-length', { primaryGoal: 'Strength', experienceLevel: 'Beginner', trainingDays: 3 }, token);
    check('the route runs', [on.status, on.body.error], [200, undefined]);
    check('and used the model once', modelCalls, 1);
    process.env.AI_PROVIDER = 'gemini';
    check('any other value is still off', (await req('POST', '/api/recommend-cycle-length', {}, token)).body.error, OFF);

    console.log('\n=== Windows Claude program guard ===\n');
    const { ensureClaudeBinary } = require(path.join(ROOT, 'claudeBinary.js'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebin-'));
    const dir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
    fs.mkdirSync(dir, { recursive: true });
    const opts = { root, platform: 'win32', arch: 'x64' };

    check('other platforms are left alone', ensureClaudeBinary({ root, platform: 'linux', arch: 'x64' }), null);
    check('a present program needs nothing', (fs.writeFileSync(path.join(dir, 'claude.exe'), 'ok'), ensureClaudeBinary(opts)), null);

    fs.rmSync(path.join(dir, 'claude.exe'));
    fs.writeFileSync(path.join(dir, 'claude.exe.old.1'), 'older');
    fs.writeFileSync(path.join(dir, 'claude.exe.old.7'), 'newest');
    check('a missing program is restored from the newest leftover', ensureClaudeBinary(opts), null);
    check('with the newest copy', fs.readFileSync(path.join(dir, 'claude.exe'), 'utf8'), 'newest');

    fs.rmSync(path.join(dir, 'claude.exe'));
    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n));
    check('nothing to restore gives a clear message', /missing/.test(ensureClaudeBinary(opts)), true);
    fs.rmSync(root, { recursive: true, force: true });

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
