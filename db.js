const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_data (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                current_plan JSONB,
                workout_journal JSONB DEFAULT '[]'::jsonb
            );
        `);
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("Failed to initialize database:", err);
    }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  initDB
};
