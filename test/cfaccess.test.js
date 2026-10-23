/*
 * Cloudflare Access sign-in.
 *
 * A real RSA key pair signs the tokens and the certs fetch is stubbed, so the test exercises
 * the actual verification: only a correctly signed, correctly addressed, unexpired RS256 token
 * for an existing account may sign in.
 */
process.env.JWT_SECRET = 'cfaccess-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AUTH_MAX = '1000';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { installPgShim, makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'aud-tag-1234567890';
const ISS = 'https://' + TEAM;

let PORT = null;
function req(method, p, body, headers) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
        if (payload) h['Content-Length'] = Buffer.byteLength(payload);
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const goodPair = pair();
const otherPair = pair();
let published = [{ kid: 'good-kid', key: goodPair.publicKey }];
let certFetches = 0;

const realFetch = global.fetch;
global.fetch = async (url, ...rest) => {
    if (String(url) === ISS + '/cdn-cgi/access/certs') {
        certFetches++;
        return {
            ok: true,
            json: async () => ({
                keys: published.map(k => Object.assign({ kid: k.kid, kty: 'RSA' }, k.key.export({ format: 'jwk' }))),
                public_cert: { kid: published[0].kid, cert: published[0].key.export({ type: 'spki', format: 'pem' }) },
                public_certs: published.map(k => ({ kid: k.kid, cert: k.key.export({ type: 'spki', format: 'pem' }) }))
            })
        };
    }
    return realFetch(url, ...rest);
};

function sign(claims, opts) {
    opts = opts || {};
    const privateKey = (opts.pair || goodPair).privateKey;
    return jwt.sign(
        Object.assign({ email: 'someone@gmail.com', aud: [AUD], iss: ISS }, claims || {}),
        privateKey,
        Object.assign({ algorithm: 'RS256', keyid: 'good-kid', expiresIn: '1h' }, opts.sign || {})
    );
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
    installPgShim();
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
    const cf = require(path.join(ROOT, 'cfAccess.js'));

    console.log('\n=== mode off: exactly as before ===\n');
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    check('the route does not exist', (await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign() })).status, 404);
    const reg = await req('POST', '/api/auth/register', { email: 'Gowen.Example@Gmail.com', password: 'password1234' });
    check('sign-up still works', reg.status, 201);
    check('and password login still works', (await req('POST', '/api/auth/login', { email: 'Gowen.Example@Gmail.com', password: 'password1234' })).status, 200);
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
    check('one variable alone is still off', (await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign() })).status, 404);

    console.log('\n=== mode on ===\n');
    process.env.CF_ACCESS_AUD = AUD;
    check('sign-up is disabled', (await req('POST', '/api/auth/register', { email: 'new@example.com', password: 'password1234' })).body.error, 'Sign-up is disabled on this server');
    check('sign-up returns 403', (await req('POST', '/api/auth/register', { email: 'new2@example.com', password: 'password1234' })).status, 403);
    check('password login stays as a fallback', (await req('POST', '/api/auth/login', { email: 'Gowen.Example@Gmail.com', password: 'password1234' })).status, 200);

    const mine = sign({ email: 'gowen.example@gmail.com' });
    const ok = await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': mine });
    check('a valid token signs in the matching account, case-insensitively', ok.status, 200);
    check('as the stored spelling', ok.body.user.email, 'Gowen.Example@Gmail.com');
    check('with the same id as a password login', ok.body.user.id, reg.body.user.id);
    const decoded = jwt.verify(ok.body.token, process.env.JWT_SECRET);
    check('the app token is signed like /login', [decoded.id, decoded.email], [reg.body.user.id, 'Gowen.Example@Gmail.com']);
    check('and lasts 7 days', Math.round((decoded.exp - decoded.iat) / 86400), 7);
    check('it works on a protected route', (await req('GET', '/api/user/data', undefined, { Authorization: 'Bearer ' + ok.body.token })).status, 200);

    const viaCookie = await req('POST', '/api/auth/cloudflare', {}, { Cookie: 'other=1; CF_Authorization=' + mine + '; x=2' });
    check('the CF_Authorization cookie works as a fallback', viaCookie.status, 200);
    check('the plain email header alone is never trusted', (await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Authenticated-User-Email': 'gowen.example@gmail.com' })).status, 401);
    check('no token at all is refused', (await req('POST', '/api/auth/cloudflare', {})).status, 401);

    console.log('\n=== tokens that must be refused ===\n');
    const refused = async (label, token, expected) => {
        const r = await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': token });
        check(label, r.status, expected || 401);
    };
    const mineClaims = { email: 'gowen.example@gmail.com' };
    await refused('wrong audience', sign(Object.assign({}, mineClaims, { aud: ['some-other-app'] })));
    await refused('wrong issuer', sign(Object.assign({}, mineClaims, { iss: 'https://evil.cloudflareaccess.com' })));
    await refused('expired', sign(mineClaims, { sign: { expiresIn: -60 } }));
    await refused('HS256 signed with a public key as the secret',
        jwt.sign(Object.assign({ aud: [AUD], iss: ISS }, mineClaims), goodPair.publicKey.export({ type: 'spki', format: 'pem' }), { algorithm: 'HS256', keyid: 'good-kid' }));
    await refused('alg none (unsigned)',
        b64({ alg: 'none', typ: 'JWT', kid: 'good-kid' }) + '.' + b64(Object.assign({ aud: [AUD], iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600 }, mineClaims)) + '.');
    await refused('signed by a different key', sign(mineClaims, { pair: otherPair }));
    await refused('unknown kid', sign(mineClaims, { sign: { keyid: 'mystery-kid' } }));
    await refused('garbage', 'not.a.token');

    console.log('\n=== accounts ===\n');
    check('no matching account is a 403', (await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign({ email: 'stranger@gmail.com' }) })).status, 403);
    check('and no account was created',
        Number((await db.query(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'stranger@gmail.com'`)).rows[0].n), 0);
    await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2), ($3, $2)', ['Twin@Gmail.com', 'x', 'twin@gmail.com']).catch(() => null);
    const twins = Number((await db.query(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'twin@gmail.com'`)).rows[0].n);
    if (twins === 2) {
        check('several matching accounts is a 403', (await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign({ email: 'twin@gmail.com' }) })).status, 403);
    } else {
        console.log('  (database forbids case-different duplicates, so the several-match case cannot occur here)');
    }

    console.log('\n=== keys ===\n');
    cf.__resetCacheForTests();
    certFetches = 0;
    await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': mine });
    await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': mine });
    check('keys are cached between sign-ins', certFetches, 1);
    certFetches = 0;
    await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign(mineClaims, { sign: { keyid: 'mystery-kid' } }) });
    check('an unknown kid refetches exactly once', certFetches, 1);
    // Cloudflare rotates: a new key appears under a new kid.
    const rotated = pair();
    published = [{ kid: 'good-kid', key: goodPair.publicKey }, { kid: 'new-kid', key: rotated.publicKey }];
    const afterRotation = await req('POST', '/api/auth/cloudflare', {}, { 'Cf-Access-Jwt-Assertion': sign(mineClaims, { pair: rotated, sign: { keyid: 'new-kid' } }) });
    check('a rotated key is picked up without a restart', afterRotation.status, 200);

    global.fetch = realFetch;
    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
