# AI sandbox

Tests whether a model can run Progressive Strength's AI features, before anything is switched over.

`node scripts/ai-sandbox/run.js` starts the real app code with a throwaway in-memory database, creates
three invented lifters, and runs every AI feature for each of them: recommend a cycle length, design a
programme, weekly review, recap, adjust the plan, and the single-week generator. It then checks the
answers and writes a report to `scripts/ai-sandbox/results/`.

Why it is safe to run on the laptop next to the live app:
- no `.env` is read, so the live database, Cloudflare sign-in and Claude switch are never touched;
- the database lives in memory and disappears when the script ends;
- the app binds a random port on 127.0.0.1, never 4120;
- all lifters and workouts are made up;
- the only outside traffic is to the model server (the Halo over Tailscale by default).

What the checks look for:
- **must** (would break the app or mislead the lifter): valid answer, every week of the cycle described,
  sets and reps on every movement, no invented records, ignores instructions hidden in a journal note,
  a clear error within seconds when the model server is off.
- **should** (quality): right number of days, one-set warm-ups, dumbbell-only plans for a home lifter,
  avoiding lunges and jumps for a sore knee, keeping movement names when adjusting a plan, counting
  workouts correctly in the recap.

Options: `--runs N` (default 3), `--url`, `--model`, `--json-mode json|schema` (constrained decoding),
`--only recommend,review,recap,adjust,plan`, `--timeout SECONDS` (default 180),
`--provider claude` (same tests on Claude, as a baseline; uses the Claude plan).
