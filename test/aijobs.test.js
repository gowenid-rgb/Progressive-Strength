/*
 * AI answers as background jobs, so a slow model never meets Cloudflare's 100-second limit.
 * "Prefer: respond-async" gets 202 { jobId } at once; GET /api/ai-jobs/:id gives the answer.
 */
process.env.JWT_SECRET = 'aijobs-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_PROVIDER = 'claude';
process.env.AI_BURST_MAX = '999';
process.env.AI_DAILY_MAX = '999';
process.env.AUTH_MAX = '999';

const path = require('path');
const http = require('http');
const { stubAI } = require('./helpers/aistub');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

let PORT = null;
function req(method, p, body, token, extra) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    installPgShim();
    const ai = require(path.join(ROOT, 'aiClient.js'));
    let delay = 0, answer = { weeks: 6, rationale: 'Six weeks suits you.' };
    stubAI(ai, async () => { await sleep(delay); return answer instanceof Error ? answer : JSON.stringify(answer); });

    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => { PORT = this.address().port; if (typeof cb === 'function') cb(); resolve(); });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;
    await require(path.join(ROOT, 'migrate.js')).migrate(require(path.join(ROOT, 'db.js')));

    const a = (await req('POST', '/api/auth/register', { email: 'a@example.com', password: 'password1234' })).body.token;
    const b = (await req('POST', '/api/auth/register', { email: 'b@example.com', password: 'password1234' })).body.token;
    const ASYNC = { Prefer: 'respond-async' };

    console.log('\n=== without the header nothing changes ===\n');
    let r = await req('POST', '/api/recommend-cycle-length', {}, a);
    check('answered in the same request', [r.status, r.body.weeks], [200, 6]);

    console.log('\n=== as a background job ===\n');
    delay = 300;
    const t0 = Date.now();
    r = await req('POST', '/api/recommend-cycle-length', {}, a, ASYNC);
    check('202 straight away', r.status, 202);
    check('before the model has answered', Date.now() - t0 < 250, true);
    const id = r.body.jobId;
    check('a job id comes back', typeof id, 'string');

    r = await req('GET', '/api/ai-jobs/' + id, undefined, a);
    check('running while the model works', r.body.status, 'running');
    check('another user cannot read it', (await req('GET', '/api/ai-jobs/' + id, undefined, b)).status, 404);
    check('it needs a login', (await req('GET', '/api/ai-jobs/' + id)).status, 401);

    await sleep(500);
    r = await req('GET', '/api/ai-jobs/' + id, undefined, a);
    check('done, with the same answer the direct call gives', [r.body.status, r.body.code, r.body.body.weeks], ['done', 200, 6]);
    check('the answer can be read again', (await req('GET', '/api/ai-jobs/' + id, undefined, a)).body.status, 'done');

    console.log('\n=== errors come back through the job too ===\n');
    delay = 0;
    answer = new Error('model down');
    r = await req('POST', '/api/recommend-cycle-length', {}, a, ASYNC);
    await sleep(200);
    r = await req('GET', '/api/ai-jobs/' + r.body.jobId, undefined, a);
    check('a failure is reported as the route reports it', [r.body.status, r.body.code], ['done', 500]);
    check('with its message', typeof r.body.body.error, 'string');

    check('an unknown id is a 404', (await req('GET', '/api/ai-jobs/nope', undefined, a)).status, 404);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
