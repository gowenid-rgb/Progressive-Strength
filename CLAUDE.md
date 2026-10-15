# Progressive Strength

A workout-tracking web app (Node/Express + Postgres, single-page front end in `public/`) with AI-generated
training programs (Google Gemini). See `DEV_JOURNAL.md` for architecture and decisions.

## How to run it
`npm start` (runs `node server.js`, needs `JWT_SECRET`; see `.env.example`).

## Local test mode (click-through testing before anything goes to main)
The local `.env` (gitignored, never commit or print it) contains:
- `JWT_SECRET` - required.
- `LOCAL_DB=1` - swaps Postgres for a file-backed PGlite database in `.devdata/` (gitignored), so no Postgres
  install is needed. Data persists between restarts; delete `.devdata/` to reset. Code: `dev/localDb.js`.
  Inert on Railway (the variable isn't set there).
- `GEMINI_API_KEY` - needed for the AI endpoints (generate/modify workouts). Without it they return a 500.

Test account, created automatically on start: `test@example.com` / `testpass123`
(override with `TEST_EMAIL` / `TEST_PASSWORD`).

To test: use Agent Hub's check_page tool with target `app`, log in as the test account, click through the
feature, then run `npm test` (all tests must pass; they use their own in-memory DB, never `.devdata/`).

## Rules
- Never put secrets in files that are committed or in chat.
- Migrations in `migrations/` are never edited after shipping; add a new numbered file.
