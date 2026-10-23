const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const { JWT_SECRET } = require('./config');
const cfAccess = require('./cfAccess');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
    // Behind Cloudflare Access the only people who get in are the ones Access admits, and their
    // accounts already exist. Open sign-up would just be a second way in.
    if (cfAccess.enabled()) return res.status(403).json({ error: 'Sign-up is disabled on this server' });
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        // Hash before opening the transaction — bcrypt takes ~100ms and there is no
        // reason to hold a pool connection for it.
        const hash = await bcrypt.hash(password, 10);

        // Registration creates only the user. Under the Phase 2 schema there is no companion
        // row to create alongside it -- a cycle is created when the user first generates a
        // plan -- so the two-insert transaction this replaced is no longer needed. That
        // pairing was what made the old silent-save-failure bug reachable in the first place.
        const inserted = await db.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
            [email, hash]
        );
        const user = inserted.rows[0];

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user });
    } catch (err) {
        // 23505 = unique_violation. Let the UNIQUE constraint decide whether the email is
        // taken instead of a SELECT-then-INSERT, which races under concurrent signups.
        if (err && err.code === '23505') {
            return res.status(400).json({ error: 'User already exists' });
        }
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = userRes.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sign in with a Cloudflare Access token instead of a password. Only ever signs in an account
// that already exists; it never creates one.
router.post('/cloudflare', async (req, res) => {
    if (!cfAccess.enabled()) return res.status(404).json({ error: 'Not found' });
    try {
        const verified = await cfAccess.verifyToken(cfAccess.extractToken(req));
        if (!verified) return res.status(401).json({ error: 'Cloudflare Access sign-in could not be verified' });

        const found = await db.query('SELECT id, email FROM users WHERE lower(email) = lower($1)', [verified.email]);
        if (found.rows.length !== 1) {
            return res.status(403).json({
                error: found.rows.length === 0
                    ? 'No account exists for ' + verified.email + '. Accounts are not created through Cloudflare Access.'
                    : 'More than one account matches ' + verified.email + '; sign in with your password instead.'
            });
        }

        const user = found.rows[0];
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
        console.error('Cloudflare sign-in error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
