# Tier 1 Fix Plan

Companion to `DEV_JOURNAL.md`. Covers `T1-0` through `T1-4`.
**Status: draft for review. No code written yet.**

Two blocking questions are marked **DECIDE** below. Everything else is settled.

---

## Why these four, together

`T1-1`, `T1-2`, and `T1-4` are all failures of the same thing: the path that decides what counts
as the user's saved data. `T1-1` sends the wrong data, `T1-2` fabricates data that was never
entered, `T1-4` drops data on the floor without complaining. Fixing them separately means touching
the same save path three times and re-testing it three times. `T1-3` is unrelated but is a
four-line change that shouldn't wait.

All four share one property worth stating plainly: **none of them produce a visible error.**
Nobody reports these. They are found by reading the code or by noticing, weeks later, that the
history is wrong.

---

## T1-0 — Establish a real working copy

**Blocks everything else.** This folder has no `.git`, so nothing edited here can reach GitHub or
Railway. Fixing that first avoids doing the work twice.

**Steps**
1. Clone the repo properly to a new directory:
   ```bash
   git clone https://github.com/gowenid-rgb/Progressive-Strength
   ```
2. Diff the clone against this folder to confirm this zip matches `main` and there's no local
   work-in-progress that would be lost.
3. Confirm Railway is deploying from `main` on that repo, and note whether it auto-deploys on push.
4. Work on a branch (`fix/tier-1-data-integrity`), not `main`.

**Also verify while we're here:** `JWT_SECRET`, `DATABASE_URL`, and `GEMINI_API_KEY` are all set in
the Railway environment. `T1-3` depends on the first one.

**Note:** this working copy is on OneDrive. A git clone inside a syncing folder can produce
lock-file conflicts. Cloning outside OneDrive is the safer default.

---

## T1-1 — Session lifecycle: stop wiping and leaking data

**Files:** `public/index.html` — `DOMContentLoaded` (~L305), `handleAuth()` (~L328), logout button (L136)

### The three bugs

**a) Boot pushes stale local data over good server data** — `index.html:311`

The sequence is: fetch server data → `await syncData()` → *then* copy `data.workoutJournal` into
localStorage. So `syncData()` posts whatever journal was already local. On a fresh browser that's
`[]`, which overwrites the server's history with an empty array. Sign in on a new phone, lose
everything.

The `await syncData()` on that line is pure downside — the plan was just fetched *from* the server.
There is no scenario where echoing it back is useful.

**b) Login repeats the same mistake** — `index.html:344`

`handleAuth()` has the identical `setItem(...); await syncData();` pattern, so logging in as user B
pushes user A's leftover journal into user B's account.

**c) Logout clears the token and nothing else** — `index.html:136`

`localStorage.removeItem('token')` leaves `currentWorkoutPlan`, `workoutJournal`, and
`journalEntries` in place for the next person on that browser.

### The fix

One principle, applied in three places: **on any session boundary, the server is the source of
truth and local state is rebuilt from scratch. The client never pushes during a read.**

1. Add a `hydrateFromServer(data)` helper that replaces *all* local keys from the server response —
   including explicitly clearing keys the server has no value for, so nothing survives from a
   previous session.
2. Add a `clearLocalSession()` helper that removes `token`, `currentWorkoutPlan`, `workoutJournal`,
   and `journalEntries`, and resets the `currentWorkoutPlan` variable to `null`.
3. Remove `await syncData()` from both `DOMContentLoaded` and `handleAuth()`.
4. Call `clearLocalSession()` at the start of `handleAuth()` (before storing the new token) and on
   logout.
5. In `DOMContentLoaded`, hydrate fully *before* calling `renderPlan()` / `nav()`, so render never
   reads half-updated state.

### Verification

- [ ] Browser A: log in, generate plan, log a workout. Confirm the row in Postgres holds the log.
- [ ] Browser B (incognito), same account: log in. History still present in the DB afterward.
- [ ] Back in browser A: reload. History still present.
- [ ] Log out as A, log in as B on the same browser. B sees no trace of A's plan or history.
- [ ] Log in as B, finish a workout, then check A's DB row is untouched.

The second and fifth checks are the ones that fail today.

---

## T1-2 — Workout logger: only record what actually happened

**Files:** `public/index.html` — `toggleSet()` (~L625), `finishWorkout()` (~L644)

### The two bugs

**a) Empty fields fall back to the prescription** — `index.html:652`

```js
const weight = input.value.trim() || input.placeholder;
const reps   = repsInput.value.trim() || repsInput.placeholder;
```

The placeholder holds the AI's *suggested* weight and reps. Skip three sets, and they're logged as
completed at target. The history then tells Gemini you hit those numbers, and it prescribes heavier
loads next cycle. The corruption compounds.

**b) The checkmark is decorative** — `toggleSet()` only mutates CSS classes. `finishWorkout()`
iterates `.workout-weight` inputs and never reads completion state at all.

### The fix

**D2 — DECIDED (2026-09-12): the checkmark is authoritative. Option A.**

A set is logged **if and only if** its box is checked. Typed numbers in an unchecked row are never
written, under any circumstance. The app does not infer completion from the presence of data.

Chosen over the hybrid deliberately: inferring intent from typed values means the history can
contain sets the user never confirmed, which is a softer version of the exact bug being fixed.
One unambiguous rule beats a forgiving one when the data feeds progressive overload.

The forgetfulness risk that made the hybrid tempting gets handled at the **exit point** instead —
validate on Finish, and make the user resolve the ambiguity themselves.

#### Logging rule

1. `toggleSet()` sets `row.dataset.done = 'true' | 'false'` on the `.set-row` element alongside the
   existing visual change. Use `el.closest('.set-row')` rather than the current
   `el.parentElement.parentElement`, which is brittle.
2. `finishWorkout()` iterates `.set-row` elements, not inputs. Skip any row where
   `dataset.done !== 'true'`. Read `.value` only — **never** fall back to `.placeholder`.
3. A checked set with blank weight logs as bodyweight (`"BW"`), not as the suggested load.
4. Drop exercises with zero checked sets from the log entirely. Build the list with an object keyed
   by index and `Object.values()` rather than the current sparse array, which serializes holes as
   `null` and gets worse once rows are filtered.

#### Pre-finish validation

On tapping **Finish**, scan every set row and sort into three buckets:

| Bucket | Meaning | Action |
|---|---|---|
| Checked | Performed | Log it |
| Unchecked **with** typed values | Ambiguous — likely forgot to tap | **Warn** |
| Unchecked and empty | Not performed | Ignore silently |

**Case 1 — some checked, some unchecked-with-data.** Warn before writing anything:

> *"3 sets have weight or reps entered but aren't checked off. Unchecked sets are not saved.
> Review them, or finish without them?"*
> → **[Review]** · **[Finish without them]**

**[Review]** returns to the workout; **[Finish without them]** proceeds and discards those rows.
Either way, unchecked sets are never logged — the prompt only decides whether the user gets
another pass at them.

**Case 2 — zero checked sets.** Don't write an empty log or burn a day out of the cycle:

> *"No sets are checked off, so nothing will be saved and this day won't count as complete.
> Discard this workout?"*
> → **[Review]** · **[Discard workout]**

**Polish (optional, same pass):** on **[Review]**, scroll to the first offending row and mark the
unchecked-with-data rows with a warning border so they're findable without hunting. Cheap to add
while the classification logic is already in hand.

**Note:** the existing `cancelWorkout()` confirm stays as-is — that's a deliberate abandon, and a
different intent from finishing with gaps.

### Verification

- [ ] Start a workout with 3 exercises × 3 sets. Fill and check only 2 sets. Finish.
- [ ] Journal entry contains exactly 2 sets, with the typed values, under one exercise.
- [ ] No `null` entries in the serialized `exercises` array.
- [ ] Check a set, leave weight blank, type reps → logs as `BW`, not the suggested weight.
- [ ] Type values into a row but leave it unchecked → warning fires naming the right count.
- [ ] Choose **Finish without them** → those sets are absent from the log. Verify in the DB.
- [ ] Choose **Review** → returns to the workout, nothing written, timer still running.
- [ ] Finish with zero checked sets → discard prompt, day **not** marked complete, no journal entry.
- [ ] Untouched empty rows never trigger the warning.
- [ ] Regression: the "Prev" column on the next workout reads the newly written history correctly.

That last one matters — `startWorkout()` reads `sets[sets.length - 1]`, so the shape has to stay
compatible.

---

## T1-3 — Fail loudly when `JWT_SECRET` is missing

**Files:** `middleware.js:3`, `authRoutes.js:7`, new `config.js`

Both files do:
```js
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev';
```

That fallback string is in a public GitHub repo. If the env var isn't set on Railway, anyone can
forge a token for any `user.id` and read or overwrite that account. There is no signal that this
is happening — the app works perfectly.

### The fix

Add `config.js` that reads the var, exits the process with a clear message if it's absent, and
exports it. Both files require it instead of reading `process.env` themselves. Also add
`.env.example` documenting all three required vars.

### Ordering — important

**Set `JWT_SECRET` in Railway *before* deploying this change**, or the app will crash-loop on boot.
Verify it's present first (part of `T1-0`).

### Consequences to expect

- If the var is set and unchanged: nothing visible happens. Nobody is logged out.
- If we *change* it, or it was unset and we're adding it now: every outstanding token becomes
  invalid and all users hit the login screen once. Acceptable, but don't be surprised by it.
- Local dev without a `.env` will now refuse to start. That's the intent.

### Verification

- [ ] With the var set: server boots, existing sessions behave normally.
- [ ] With it unset locally: process exits immediately with a readable message, not a stack trace.
- [ ] A token signed with the old fallback secret is rejected with 403.

---

## T1-4 — Make the save actually save

**File:** `server.js:45`

```sql
UPDATE user_data SET current_plan = $1, workout_journal = $2 WHERE user_id = $3
```

Affects zero rows if the row doesn't exist, and the handler returns `{success: true}` regardless.
The row is only created at registration (`authRoutes.js:21`), so any account created before that
line existed — or any registration where the second insert failed — saves into the void forever.

### The fix

1. Switch to an upsert. `user_id` is the primary key, so `ON CONFLICT (user_id) DO UPDATE` is
   straightforward.
2. Check `result.rowCount === 1` and return a 500 if not. A save that writes nothing must not
   report success.
3. Wrap the two inserts in `authRoutes.js` register in a transaction, so a user row can't exist
   without its `user_data` row in the first place.

**Optional, decide now because it's cheap while we're here:** add an `updated_at` column to support
stale-write rejection (`T3-3`). It requires an `ALTER TABLE` — `initDB` uses
`CREATE TABLE IF NOT EXISTS` and will not add columns to the existing table. If we're adding a
migration path anyway, doing it once for two columns beats doing it twice. Leaning yes, but it
expands scope; fine to defer.

### Verification

- [ ] Normal save on an existing account still works.
- [ ] Manually `DELETE FROM user_data WHERE user_id = X`, then save → row is recreated, not silently lost.
- [ ] Simulate a failure mid-registration → no orphaned `users` row without `user_data`.

---

## Execution order

```
T1-0  clone repo, verify Railway env vars        ← blocks everything
  │
  ├── T1-3  JWT guard          (server, independent, ~15 min)
  ├── T1-4  upsert + txn       (server, independent, ~30 min)
  │
  └── T1-1  session lifecycle  (client, do before T1-2 — both touch the save path)
        └── T1-2  logger fix   (client, depends on T1-1's helpers)
```

Server-side work (`T1-3`, `T1-4`) can ship as one deploy. Client-side (`T1-1`, `T1-2`) as a second.
Splitting them means that if something breaks, the surface area is obvious.

---

## Before touching anything: back up production data

Non-negotiable given that three of these bugs are about data loss.

```bash
pg_dump "$DATABASE_URL" -t users -t user_data > backup_pre_tier1.sql
```

Railway exposes `DATABASE_URL` in the service variables. Keep the dump until all Tier 1 changes
have been live for a few days.

Worth checking the dump for damage that has *already* happened — accounts with an empty
`workout_journal` but a well-developed `current_plan` are the signature of `T1-1(a)` having
fired. If any exist, that history is already gone, and it's worth knowing before we claim the bug
is fixed.

---

## Out of scope

Deliberately not in this pass, to keep the diff reviewable:

- Multi-device conflict handling beyond not-actively-destroying-data (`T3-3`)
- Any schema normalization (`T3-3` long-term)
- The Gemini call verification (`T2-2`) — separate concern, separate deploy
- Rate limiting (`T2-3`)
- XSS escaping (`T3-4`)

---

## Open questions blocking start

1. ~~**D2 — set completion semantics.**~~ **Resolved 2026-09-12:** checkmark authoritative,
   with a pre-finish warning. See `T1-2`.
2. **`updated_at` now or later?** Cheap while we're already writing a migration; expands scope.
3. **Has anyone besides you used this in production?** Changes how carefully we handle the
   forced logout in `T1-3` and how much the already-lost history in `T1-1` matters.
4. **Where does the git clone live?** OneDrive (consistent with existing layout) vs. outside it
   (safer for git internals). See `T1-0`.
