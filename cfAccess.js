// Cloudflare Access sign-in.
//
// When the app is served behind Cloudflare Access, every request carries a signed token
// (Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie). This module verifies that
// token against Cloudflare's published public keys. It never trusts the plain
// Cf-Access-Authenticated-User-Email header: anything that can reach the app directly could
// forge it, whereas a token cannot be forged without Cloudflare's private key.
//
// Off unless both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

const KEY_TTL_MS = 60 * 60 * 1000;

let cache = { keys: new Map(), fetchedAt: 0, domain: null };

function enabled() {
    return !!(config.CF_ACCESS_TEAM_DOMAIN && config.CF_ACCESS_AUD);
}

function issuer() {
    return 'https://' + config.CF_ACCESS_TEAM_DOMAIN;
}

/** The raw token from the header, falling back to the CF_Authorization cookie. */
function extractToken(req) {
    const header = req.headers && req.headers['cf-access-jwt-assertion'];
    if (header) return String(header);
    const cookie = (req.headers && req.headers.cookie) || '';
    const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
    return m ? decodeURIComponent(m[1]) : null;
}

function toKey(entry) {
    if (entry.cert) return crypto.createPublicKey(entry.cert);        // certificate or public-key PEM
    return crypto.createPublicKey({ key: entry, format: 'jwk' });      // JWK fallback
}

async function fetchKeys() {
    const res = await fetch(issuer() + '/cdn-cgi/access/certs');
    if (!res.ok) throw new Error('certs request failed: ' + res.status);
    const body = await res.json();
    const keys = new Map();
    (Array.isArray(body.public_certs) ? body.public_certs : []).forEach(c => {
        if (c && c.kid && c.cert) keys.set(c.kid, toKey(c));
    });
    // Same keys in JWK form, used only for a kid that public_certs did not list.
    (Array.isArray(body.keys) ? body.keys : []).forEach(k => {
        if (k && k.kid && !keys.has(k.kid)) keys.set(k.kid, toKey(k));
    });
    cache = { keys, fetchedAt: Date.now(), domain: config.CF_ACCESS_TEAM_DOMAIN };
}

async function keyFor(kid) {
    const fresh = cache.domain === config.CF_ACCESS_TEAM_DOMAIN && Date.now() - cache.fetchedAt < KEY_TTL_MS;
    if (!fresh) await fetchKeys();
    if (cache.keys.has(kid)) return cache.keys.get(kid);
    // An unknown kid may mean Cloudflare rotated its keys: refetch once, then give up.
    if (fresh) await fetchKeys();
    return cache.keys.get(kid) || null;
}

/**
 * Verifies an Access token. Returns { email } on success, or null for any failure (bad
 * signature, wrong algorithm, audience or issuer, expired, unknown key, network trouble).
 */
async function verifyToken(token) {
    try {
        if (!enabled() || !token) return null;
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) return null;

        const key = await keyFor(decoded.header.kid);
        if (!key) return null;

        const payload = jwt.verify(token, key, {
            algorithms: ['RS256'],
            audience: config.CF_ACCESS_AUD,
            issuer: issuer()
        });
        const email = typeof payload.email === 'string' ? payload.email.trim() : '';
        return email ? { email } : null;
    } catch (err) {
        return null;
    }
}

function __resetCacheForTests() {
    cache = { keys: new Map(), fetchedAt: 0, domain: null };
}

module.exports = { enabled, extractToken, verifyToken, __resetCacheForTests };
