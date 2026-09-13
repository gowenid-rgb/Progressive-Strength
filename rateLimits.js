// Rate limits for the Gemini-backed endpoints.
//
// These routes each cost a model call, so an authenticated user looping them bills the
// project's API key without bound. Registration is open and unverified, so the supply of
// accounts an attacker can create is effectively unlimited too.
//
// Limits are keyed by USER ID rather than IP: these routes all sit behind authenticateToken,
// and IP keying would both punish users sharing a NAT and be trivially sidestepped.
//
// Tunable without a code change — see .env.example.
const { rateLimit } = require('express-rate-limit');

const num = (name, fallback) => {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const AI_BURST_MAX = num('AI_BURST_MAX', 10);        // per 15 minutes
const AI_DAILY_MAX = num('AI_DAILY_MAX', 40);        // per 24 hours

// Must run after authenticateToken. Falls back to IP only if it is somehow mounted before
// auth, so a misordering fails closed rather than handing everyone a shared unlimited bucket.
const byUser = req => (req.user && req.user.id ? 'u:' + req.user.id : 'ip:' + req.ip);

const deny = (message, retryHint) => (req, res) => {
    console.warn(`Rate limit hit by ${byUser(req)} on ${req.path}`);
    res.status(429).json({ error: message, retryAfter: retryHint });
};

const common = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Key is a user id, not an address, so the IPv6 subnet validator does not apply.
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: byUser
};

const aiBurstLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: AI_BURST_MAX,
    handler: deny(
        'You are generating plans very quickly. Please wait a few minutes and try again.',
        '15 minutes'
    )
});

const aiDailyLimiter = rateLimit({
    ...common,
    windowMs: 24 * 60 * 60 * 1000,
    limit: AI_DAILY_MAX,
    handler: deny(
        'Daily limit for AI generations reached. This resets 24 hours after your first request today.',
        '24 hours'
    )
});

// Auth endpoints are unauthenticated, so these genuinely must key on IP. Slows credential
// stuffing and stops one host creating accounts in bulk to farm AI quota.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: num('AUTH_MAX', 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
        console.warn(`Auth rate limit hit from ${req.ip} on ${req.path}`);
        res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    }
});

// Applied in order: a burst cap for runaway loops, then a daily cap for sustained abuse.
const aiLimiters = [aiBurstLimiter, aiDailyLimiter];

module.exports = { aiLimiters, authLimiter, AI_BURST_MAX, AI_DAILY_MAX };
