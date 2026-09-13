const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const { JWT_SECRET } = require('./config');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        // Hash before opening the transaction — bcrypt takes ~100ms and there is no
        // reason to hold a pool connection for it.
        const hash = await bcrypt.hash(password, 10);

        // Both inserts must succeed together. Previously a failure on the second left a
        // users row with no user_data row, and every save that account ever made would
        // silently write nothing.
        const user = await db.withTransaction(async (client) => {
            const inserted = await client.query(
                'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
                [email, hash]
            );
            await client.query('INSERT INTO user_data (user_id) VALUES ($1)', [inserted.rows[0].id]);
            return inserted.rows[0];
        });

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

module.exports = router;
