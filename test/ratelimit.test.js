/*
 * Tier 2 tests — rate limiting (T2-3), API 404s (T2-5), and the debug-route gate (T2-4).
 *
 * Boots the real server in-process against an ephemeral port and drives it over HTTP, so
 * middleware ordering is genuinely exercised. No database or Gemini key needed: the routes
 * under test must reject before reaching either.
 */
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

function request(port, method, p, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) },
            res => {
                let body = '';
                res.on('data', d => { body += d; });
                res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
            }
        );
        req.on('error', reject);
        if (method === 'POST') req.write('{}');
        req.end();
    });
}

(async () => {
    // Small limits so the test is fast and deterministic.
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough-to-avoid-the-warning';
    process.env.AI_BURST_MAX = '3';
    process.env.AI_DAILY_MAX = '100';
    process.env.AUTH_MAX = '4';
    delete process.env.DATABASE_URL;
    delete process.env.GEMINI_API_KEY;

    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    const tokenFor = id => jwt.sign({ id, email: 'u' + id + '@x.com' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // server.js calls app.listen itself, so intercept the port it binds.
    const realListen = http.Server.prototype.listen;
    let boundPort = null;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            const r = realListen.call(this, 0, () => {
                boundPort = this.address().port;
                if (typeof cb === 'function') cb();
                resolve();
            });
            return r;
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;

    const port = boundPort;
    const authA = { Authorization: 'Bearer ' + tokenFor(1) };
    const authB = { Authorization: 'Bearer ' + tokenFor(2) };

    console.log('\n=== T2-3: AI endpoint rate limiting ===\n');

    // AI_BURST_MAX = 3. The 4th request from the same user must be refused.
    const codes = [];
    for (let i = 0; i < 4; i++) {
        const r = await request(port, 'POST', '/api/generate-plan', authA);
        codes.push(r.status);
    }
    check('first 3 requests are not rate limited', codes.slice(0, 3).every(c => c !== 429), true);
    check('4th request is rejected with 429', codes[3], 429);

    const limited = await request(port, 'POST', '/api/generate-plan', authA);
    check('limit response is JSON, not HTML', limited.headers['content-type'].includes('application/json'), true);
    check('limit response explains the wait', JSON.parse(limited.body).retryAfter, '15 minutes');
    check('sends standard RateLimit headers', 'ratelimit' in limited.headers || 'ratelimit-limit' in limited.headers, true);

    // Keyed by user, so a different account must be unaffected by user 1 exhausting theirs.
    const other = await request(port, 'POST', '/api/generate-plan', authB);
    check('a different user is NOT limited by user 1', other.status !== 429, true);

    // The limiter sits behind auth, so an anonymous caller is rejected as unauthorised.
    const anon = await request(port, 'POST', '/api/generate-plan', {});
    check('unauthenticated AI request is 401', anon.status, 401);

    // Each AI route carries the limiter.
    for (const route of ['recalibrate-plan', 'generate-recap']) {
        const rs = [];
        const tok = { Authorization: 'Bearer ' + tokenFor(route) };
        for (let i = 0; i < 4; i++) rs.push((await request(port, 'POST', '/api/' + route, tok)).status);
        check('/api/' + route + ' is rate limited', rs[3], 429);
    }

    console.log('\n=== T2-5: unknown API routes return JSON 404 ===\n');

    const unknown = await request(port, 'GET', '/api/does-not-exist', {});
    check('unknown API route is 404, not 200', unknown.status, 404);
    check('unknown API route returns JSON', unknown.headers['content-type'].includes('application/json'), true);
    check('body is parseable JSON with an error', typeof JSON.parse(unknown.body).error, 'string');

    // The SPA catch-all must still serve the app for non-API paths.
    const spa = await request(port, 'GET', '/some/deep/link', {});
    check('non-API route still serves the SPA', spa.status, 200);
    check('SPA response is HTML', spa.headers['content-type'].includes('text/html'), true);

    console.log('\n=== T2-4: debug model route is gated ===\n');

    const modelsAnon = await request(port, 'GET', '/api/models', {});
    check('/api/models rejects anonymous callers', modelsAnon.status, 401);

    // Fails closed: with NODE_ENV unset (as it may be in any environment), the route is off.
    delete process.env.NODE_ENV;
    const modelsDefault = await request(port, 'GET', '/api/models', authB);
    check('/api/models is 404 when NODE_ENV is unset', modelsDefault.status, 404);

    process.env.NODE_ENV = 'production';
    const modelsProd = await request(port, 'GET', '/api/models', authB);
    check('/api/models is 404 in production even when authed', modelsProd.status, 404);
    delete process.env.NODE_ENV;

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
