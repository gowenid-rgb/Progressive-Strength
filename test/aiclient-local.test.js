/*
 * AI_PROVIDER=local: the same generateJSON path, sent to an OpenAI-compatible server on the
 * home network. A fake server on 127.0.0.1 plays the model, so this needs no network.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-long-enough-to-avoid-the-warning';
process.env.AI_PROVIDER = 'local';
delete process.env.LOCAL_AI_MODEL;
delete process.env.LOCAL_AI_JSON_MODE;

const path = require('path');
const http = require('http');
const ai = require(path.join(__dirname, '..', 'aiClient.js'));
const { makeChecker } = require('./helpers/pgshim');
const { check, report } = makeChecker();

const VALID = JSON.stringify({ planName: 'Base', week: 1, days: [{ dayName: 'Push', exercises: [{ name: 'Bench Press', sets: 3, reps: '5' }] }] });
const planArgs = () => ({ prompt: 'make a plan', schema: ai.PLAN_SCHEMA, validate: ai.validatePlan, label: 'test' });

// Each entry answers one chat call: a string (the reply text), { status, text }, or { hang: true }.
let replies = [];
let requests = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ data: [{ id: 'fake-local-model' }] }));
        }
        requests.push(JSON.parse(body || '{}'));
        const r = replies.length > 1 ? replies.shift() : replies[0];
        if (r && r.hang) return; // never answers
        if (r && r.status) { res.statusCode = r.status; return res.end(r.text || ''); }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r } }] }));
    });
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.LOCAL_AI_URL = 'http://127.0.0.1:' + server.address().port + '/v1/';
    ai.__setTimeoutForTests(400);

    console.log('\n=== local provider ===\n');

    replies = [VALID]; requests = [];
    check('clean JSON is accepted', (await ai.generateJSON(planArgs())).planName, 'Base');
    check('the model name is asked of the server when unset', requests[0].model, 'fake-local-model');
    check('the schema is in the prompt', requests[0].messages[1].content.includes('"planName"'), true);
    check('the system prompt demands JSON only', /only a single JSON object/.test(requests[0].messages[0].content), true);
    check('thinking is switched off', requests[0].chat_template_kwargs.enable_thinking, false);
    check('schema-constrained decoding by default', requests[0].response_format && requests[0].response_format.type, 'json_schema');

    replies = ['<think>maybe {"days": []} would do</think>\nHere you go: ' + VALID];
    check('a thinking block with braces is skipped', (await ai.generateJSON(planArgs())).planName, 'Base');

    replies = ['{"planName":"x","days":[]}', VALID]; requests = [];
    check('invalid then valid is retried', (await ai.generateJSON(planArgs())).planName, 'Base');
    check('exactly two calls', requests.length, 2);

    replies = [{ status: 503, text: 'loading model' }];
    let err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a server error is reported plainly', /HTTP 503/.test(err || ''), true);

    replies = [{ hang: true }];
    err = null;
    const t0 = Date.now();
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a call that never answers times out', /did not answer within/.test(err || ''), true);
    check('the timeout was the short test one', Date.now() - t0 < 5000, true);

    process.env.LOCAL_AI_JSON_MODE = 'off';
    process.env.LOCAL_AI_MODEL = 'named-model';
    replies = [VALID]; requests = [];
    await ai.generateJSON(planArgs());
    check('LOCAL_AI_MODEL is used when set', requests[0].model, 'named-model');
    check('"off" sends no response_format', requests[0].response_format, undefined);

    check('stripThinking leaves plain text alone', ai.stripThinking('{"a":1}'), '{"a":1}');

    server.closeAllConnections && server.closeAllConnections();
    server.close();
    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
