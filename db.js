const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const { migrate } = require('./migrate');

// Schema is owned by numbered files in migrations/, applied in order and recorded in
// schema_migrations. The previous CREATE TABLE IF NOT EXISTS approach could create tables
// but never alter them, so every later schema change was blocked unless data was discarded.
const initDB = async () => {
    try {
        await migrate(module.exports);
    } catch (err) {
        console.error('Migration failed:', err);
        throw err;
    }
};

// Runs fn inside a transaction, rolling back if it throws. The callback receives a
// dedicated client — every query in fn must use it, not db.query, or it will run on a
// different connection and outside the transaction.
const withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

// Borrows a single pooled connection for the caller. Needed for anything that must run
// several statements on the SAME connection -- session-scoped advisory locks, for instance,
// which are released by the connection that took them.
const withClient = async (fn) => {
    const client = await pool.connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  withClient,
  initDB
};
