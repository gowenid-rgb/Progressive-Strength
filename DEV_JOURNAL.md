# Progressive Strength — Development Journal

Working doc for tracking issues, decisions, and reasoning **before** code changes are made.
Nothing here is a commitment to implement; it's a place to think out loud and keep context
between sessions.

- **Started:** 2026-09-12
- **Repo:** https://github.com/gowenid-rgb/Progressive-Strength
- **Deploy:** Railway project `54902ae0-8835-4501-a261-4462fb4330b9`
- **Working copy:** `C:/Users/gowen/Code/Progressive-Strength` (outside OneDrive — see `D5`)

> The extracted zip under `OneDrive/Desktop/Coding Projects/Progressive Strength Control` is
> **dead** as of 2026-09-12. Verified byte-identical to `main` (line endings only); safe to
> delete. All work happens in the clone from here.

---

## How to use this doc

1. New issue found → add it to **Open Issues** with an ID, evidence, and a *proposed* fix.
2. Before writing code → move it to **Active Work**, resolve its open questions first.
3. After shipping → move to **Shipped**, add a dated entry in **Log** with what actually happened.

Issue IDs are stable. Don't renumber; retire instead.

**Status legend:** `OPEN` · `PLANNED` (fix agreed) · `IN PROGRESS` · `SHIPPED` · `WONTFIX`

---

## Architecture in one paragraph

Express 4 server (`server.js`) serving a single static `public/index.html` (~874 lines, no build
step, Tailwind via CDN). Postgres holds two tables: `users` and `user_data`, the latter storing the
whole workout plan and the whole lift history as two JSONB blobs, one row per user. Auth is
bcrypt + a 7-day JWT held in `localStorage`. Three endpoints call Gemini to generate a plan,
recalibrate it from free-text feedback, and write a weekly recap. The client is **localStorage-first**:
all writes land locally, then `syncData()` pushes the full blob to `/api/user/data`. That
local-first design is the root cause of most of the Tier 1 bugs below.

---

## Constraints & gotchas

Things about this codebase that will bite us repeatedly. Read before planning any change.

- **This working copy is not a git clone.** It's an extracted zip with no `.git`. Edits here reach
  neither GitHub nor Railway. Must be resolved before any fix ships — see `T1-0`.
- **There is no migration mechanism.** `db.initDB()` uses `CREATE TABLE IF NOT EXISTS`, which will
  *not* add columns to an already-created table. Any schema change (`T3-2`, `T3-3`) needs a real
  `ALTER TABLE` path, not an edit to `initDB`.
- ~~**No test framework, no CI.**~~ **Resolved 2026-09-12.** `npm test` runs 59 assertions with
  no external services: client logic via `node:vm` with a stubbed DOM, database logic against
  real PostgreSQL via PGlite (WASM). Add regression cases here for every future fix.
- **No staging environment.** Railway deploys straight to the thing people use.
- **`user_data` is two JSON blobs.** Every save rewrites the entire plan and entire history.
  There is no partial update and no conflict detection.
- **The client trusts localStorage over the server** everywhere except first load. This is backwards
  for a multi-device app and is the shared root cause of `T1-1`.
- **Changing `JWT_SECRET` logs out every user**, since all outstanding tokens become invalid.

---

## Active Work — Tier 1

Critical. Silent data corruption and an auth weakness. Detailed plan in `TIER1_PLAN.md`.

| ID | Issue | Status |
|----|-------|--------|
| T1-0 | Working copy is not a git clone — no path to deploy | `SHIPPED` (2026-09-12) |
| T1-1 | Session lifecycle wipes history and leaks data between accounts | `SHIPPED` to branch, tested |
| T1-2 | Workout logger records sets the user never performed | `SHIPPED` to branch, tested |
| T1-3 | `JWT_SECRET` falls back to a hardcoded public value | `SHIPPED` to branch, tested |
| T1-4 | `user_data` save is `UPDATE`, silently no-ops when row is missing | `SHIPPED` to branch, **verified vs real Postgres** |
| T1-5 | Production credentials exposed in a screenshot — rotate all three | `GEMINI key rotated` 2026-09-12; JWT/DB pending |

---

## Open Issues — Tier 2 (reliability & cost)

### T2-1 — Fragile AI JSON parsing, no validation or retry · `SHIPPED to branch` 2026-09-12

**Where:** `server.js` — all three AI endpoints (~L108, ~L185, ~L232)

**Symptom:** One malformed model response 500s the request. User waits ~10s and gets
"Failed to generate plan" with no retry and nothing salvaged.

**Root cause:** Three compounding weaknesses.
- `JSON.parse(textResult.trim())` is not individually guarded — it throws into the generic catch.
- Fence-stripping checks `startsWith` on a markdown fence, which misses any response with leading
  whitespace or a prose preamble before the fence.
- No schema validation. A syntactically valid JSON object missing `days` renders a blank plan
  and gets persisted as the user's active program.

**Proposed fix:** Extract the first balanced `{...}` block by regex rather than checking the prefix;
validate shape (`days` is a non-empty array; every exercise has a `name`) before returning; retry
once on parse or validation failure. Factor into one shared `callModelForJSON(prompt, validator)`
helper — the three endpoints are near-identical and should not drift.

**Open question:** Retry with the same prompt, or append "your last response was invalid JSON"?
The second is more likely to succeed but doubles worst-case latency to ~20s.

---

### T2-2 — Verify the Gemini SDK call · `RESOLVED 2026-09-12` — call was valid

**Where:** `server.js` — `ai.interactions.create({ model: 'gemini-3.8-flash', input: prompt })`

**Symptom:** Unknown. Needs empirical confirmation before anything else in Tier 2.

**Concern:** Can't confirm that method/model pair against `@google/genai` 2.21.0 from source —
`node_modules` isn't installed here. The triple-fallback response read
(`response.outputText || response.output_text || response.text`) reads like it was written by
guessing at the response shape rather than from a known-good call.

**Proposed fix:** `npm install`, then a throwaway script that makes one real call and dumps the
response object. Confirm the method exists, the model ID resolves, and which property holds the
text. Everything else in Tier 2 is wasted effort if this is broken.

**Note:** If plan generation is currently failing in production, **start here**, not with `T2-1`.

---

### T2-3 — No rate limiting on AI endpoints · `SHIPPED to branch` 2026-09-12

**Where:** `server.js` — `/api/generate-plan`, `/api/recalibrate-plan`, `/api/generate-recap`

**Symptom:** Any registered account can loop these and bill the Gemini key without limit.
Registration is open with no email verification, so the attacker supply is unbounded.

**Proposed fix:** `express-rate-limit` on the three AI routes, plus a per-user daily generation cap
persisted in the DB. Cheap insurance; low effort.

**Open question:** What's the intended user base? If this stays single-user or friends-only, an
allowlist on registration is simpler and strictly more effective than rate limiting. See `D1`.

---

### T2-4 — Unauthenticated `/api/models` debug route · `SHIPPED to branch` 2026-09-12

**Where:** `server.js:243`

**Symptom:** Public endpoint that proxies the server's Gemini API key to Google and returns the
model list. Leaks only model names today — the key itself stays server-side — but it's an
unauthenticated route with no purpose in a deployed app.

**Proposed fix:** Delete it. If model listing is wanted for debugging, gate it behind
`authenticateToken` and a `NODE_ENV !== 'production'` check.

---

### T2-5 — Catch-all route swallows bad API requests · `SHIPPED to branch` 2026-09-12

**Where:** `server.js:260` — `app.get('*', ...)`

**Symptom:** A typo'd or removed GET endpoint returns `index.html` with status 200. The client
then tries to `JSON.parse` an HTML document, throws, and reports "Network error" — masking the
real problem and making future debugging much harder than it should be.

**Proposed fix:** Mount an `/api/*` handler returning a JSON 404 *above* the SPA catch-all.

---

## Open Issues — Tier 3 (worth doing soon)

### T3-1 — The cycle week never advances · `FIXED by T3-11`

**Where:** `server.js` prompts (week is hardcoded to 1 in the schema block); `index.html` `renderPlan()`

**Symptom:** The W1–W4 Base/Build/Peak/Deload timeline on the plan screen is decoration. Every
generated plan is week 1 forever.

**Why it matters:** This is the product gap, not just a bug. The app is called *Progressive*
Strength; periodization is the premise, and it isn't implemented.

**Proposed fix:** Track cycle week server-side in `user_data`, increment when all days in a plan
are marked complete, and pass the week number plus phase-appropriate instructions into the prompt
(volume accumulation in Base/Build, intensity in Peak, reduced load in Deload).

**Open question:** Bigger design question hiding here — should a "cycle" be 4 weeks of *distinct*
plans, or the same plan progressively loaded? Decide before building. Depends on `T3-3`
(the blob schema) if we want to keep plan history rather than overwriting. See `D3`, `D4`.

---

### T3-2 — `journalEntries` never syncs to the server · `FIXED by T3-14`

**Where:** `index.html` `syncData()` (~L355) sends only `currentPlan` and `workoutJournal`

**Symptom:** Check-in reflections (energy, pains, intentions) live in localStorage forever and are
lost on any new device — even though `/api/generate-plan` explicitly accepts and prompts on them.

**Proposed fix:** Add a `journal_entries` JSONB column to `user_data`, include it in the sync
payload and the GET response. Needs the `ALTER TABLE` path noted in **Constraints**.

---

### T3-3 — Last-write-wins blob sync · `FIXED by T3-14` (history is now append-only)

**Symptom:** Two open tabs, or a phone plus a laptop, and the loser's data silently vanishes.
No version check, no merge, no conflict surface.

**Proposed fix (staged):**
1. Short term — add `updated_at` to `user_data`; client sends the timestamp it loaded; server
   rejects stale writes with 409 and the client re-fetches.
2. Long term — normalize `workout_journal` into its own table with append-only inserts. Workout
   logs are immutable events; storing them in a rewritten blob is the actual design error.

**Note:** `T1-1` reduces the blast radius but does not fix this.

---

### T3-4 — XSS via `innerHTML` with model-generated content · `OPEN`

**Where:** `index.html` — `renderPlan()`, `startWorkout()`, `generateRecap()`

**Symptom:** Plan names, day names, exercise names, `workoutIntro`, and recap text all interpolate
into template literals assigned to `innerHTML`, unescaped.

**Threat model:** Gemini is the proximate source, but the user's own `extraDetails` free-text field
feeds the prompt, so a crafted input can steer what the model emits. Self-inflicted only — there's
no cross-user content path today — which is why this sits in Tier 3 rather than Tier 1.

**Proposed fix:** An `escapeHtml()` helper applied at every interpolation point, or move text into
`textContent` after building the element skeleton.

---

### T3-5 — Service worker caches authenticated API responses · `OPEN`

**Where:** `public/sw.js` — the `fetch` handler caches every GET, including `/api/user/data`

**Symptom:** On a shared device, an offline load can serve the previous user's plan and history
out of CacheStorage.

**Proposed fix:** Skip caching for any request whose path starts with `/api/`. Also worth clearing
CacheStorage on logout once `T1-1` lands.

---

### T3-6 — `patch_auth.js` is a loaded gun · `OPEN`

**Where:** `patch_auth.js` (root)

**Symptom:** A one-shot migration script, already applied, still sitting in the repo. Its regex at
~L105 drops the capture group from `JSON.stringify(currentWorkoutPlan)`, leaving
`JSON.stringify()` with no argument. Re-running it silently corrupts `index.html` in a way that's
easy to miss and annoying to trace.

**Proposed fix:** Delete. Its history is in git if it's ever needed.

---

### T3-7 — Housekeeping bundle · `OPEN`

Small, independent, none urgent:

- `finishWorkout()` calls `syncData()` twice (`index.html` ~L679 and ~L682).
- Login/register send `Authorization: Bearer null` — harmless artifact of `patch_auth.js`'s
  blanket regex over all `fetch` headers.
- No password length or complexity validation in `authRoutes.js`.
- No email normalization — `User@x.com` and `user@x.com` register as two accounts.
- Every error path is a bare `alert()`. No inline error states, no retry affordance.
- No `README`, no `.env.example`. Nothing documents the three required env vars.

---

---

# Phase 2 — Roadmap

Added 2026-09-12. Six items, **ranked by complexity, easiest first**, which is the order we
intend to build them. Tier 1 and Tier 2 were about stopping the app from corrupting data. This
is about making it the app it is supposed to be.

Everything below is design, not commitment. Open questions are marked and should be settled
before the relevant item starts.

## The strategic point: there is a free-migration window, and it will close

**The user is currently the only user, and has said data can be purged.** That makes a clean
schema redesign approximately free right now. The moment a second person has history worth
keeping, every schema change needs a migration path — and `initDB()` uses
`CREATE TABLE IF NOT EXISTS`, so it cannot alter existing tables (see **Constraints**).

Three of the six items below want schema changes (`T3-10`, `T3-11`, and `T3-13`). Doing them on
today's two-JSONB-blob schema means building the metrics layer once on blobs and again after
normalisation.

**Recommendation:** take `T3-3` (normalise the journal) as a foundation step before `T3-10`,
rather than last. It is not the easiest item, so it breaks the easiest-first rule — but it is the
cheapest it will ever be, and it removes rework from two items downstream. The user also wants a
6-week cycle, which needs the new schema anyway, so the trigger is already here.

This is a recommendation, not a decision. See `D10`.

## Dependency graph

```
T3-8   visual bug            DONE
T3-14  schema foundation     DONE   <-- the free-migration window, spent
T3-11  variable cycles       DONE
         |
T3-9   exercise swap --------+   (writes sets, so it needed the schema first)

T3-10  metrics + aggregates -----+-- T3-12  long-term AI review

T3-13a journal capture log ------+-- T3-13b  read-only coach
```

`T3-12` is gated on `T3-10`: an AI reviewing a year of training needs aggregates, because raw
logs will not fit a context window affordably.

`T3-13b` is **not** gated on `T3-10` — it needs history and notes, both of which already exist.
Aggregates make the coach better, not possible. Updated 2026-09-12 when the two-agent split was
dropped in favour of the separation the layout already provides.

---

## 1. T3-8 — Cycle timeline overlaps the header when scrolling · `SHIPPED` 2026-09-12

**Complexity: trivial.** One CSS change, plus one trap.

**Where:** `public/index.html:131` (sticky header), `:146-153` (timeline), and `renderPlan()`

**Cause:** The header is `sticky top-0 z-10`. The W1-W4 nodes are also `z-10`, and as flex
items `z-index` applies to them. Equal z-index, and the nodes come later in the DOM, so they
paint over the header.

**The trap:** `renderPlan()` rebuilds `node.className` on every render and writes `z-10` back
in. Fixing only the static HTML would look correct until the first plan loads, then regress.

**Fix:** give the timeline wrapper (`:146`) `relative z-0`. That creates a stacking context
containing the whole group, so the nodes still sit above their connector line but the group sits
below the header — and it holds regardless of what `renderPlan()` writes to the children. Raising
the header to `z-20` also works but leaves the same trap for the next person.

**Depends on:** nothing. **Blocks:** nothing. Good first task.

---

## 2. T3-9 — Swap an exercise mid-workout · `SHIPPED` 2026-09-12

**Complexity: low-medium.** Self-contained UI, but it writes to the log, so it must respect the
invariants `T1-2` established.

**What:** a **Swap** button on each exercise in the active workout. Tapping it offers
alternatives for that movement pattern, plus **Enter your own**. Pull-ups would offer lat
pulldowns, bent-over rows, seated cable rows, or free text like "assisted pull-ups".

**Systems touched:**
- `startWorkout()` — render the button and the picker
- `finishWorkout()` — the log must record **what was actually performed**, not what was
  prescribed, and flag it as a substitution so the AI can see the swap happened
- The `Prev` column lookup matches on exercise name, so a swapped-in movement should surface
  *its own* history, not the replaced movement's
- `T1-2` invariant: a swapped exercise's sets still only log when checked

**Why the substitution flag matters:** without it, the AI sees a user who silently stopped doing
pull-ups and started doing lat pulldowns, and has no idea it was an equipment constraint rather
than a programming choice. With it, the next cycle can either honour the substitution or program
back toward the original.

**Open questions:**
- `D6` — does a swap apply to **this session only**, or persist into the remaining weeks of the
  cycle? Recommend session-only by default with an optional "use this for the rest of the cycle",
  since the common case is a busy squat rack, not a permanent change.
- `D7` — are alternatives a **static map** or **AI-generated**? Recommend static: it is instant,
  works offline, costs nothing, and a mid-workout AI round trip is bad UX while resting between
  sets. An AI fallback for unrecognised movements is a reasonable later addition.

---

## 3. T3-10 — Rewrite the Metrics tab as real data, not AI · `SHIPPED` 2026-09-13

**Complexity: medium.** The UI is straightforward. The data underneath is the actual work.

**What:** replace the AI recap button with a static dashboard — workouts completed this
week/month/year, a line graph of lifting progression, total weight moved, and similar. This
doubles as **the aggregate layer the AI reads for long-term context** (`T3-12`).

**The real problem: weight and reps are free-text strings.** The journal stores whatever the
user typed — `"225"`, `"225 lbs"`, `"BW"`, `"100kg"`, `"bodyweight"`. Nothing can be summed,
averaged or plotted until that is parsed into a number plus a unit. Two halves:

- **Going forward:** normalise at write time. Store `{ value, unit, isBodyweight }` alongside the
  raw string so the original is never lost.
- **Backwards:** parse existing history, or accept that it is unusable.

**The purge makes the second half disappear entirely** — a strong argument for doing this after
`T3-3` rather than before.

**Charting:** recommend hand-rolled SVG rather than a charting library. The CSP allows scripts
only from a few CDNs, the app is a PWA that should work offline, and a line chart of one series is
perhaps 40 lines of SVG. A library is a large dependency for one chart.

**Progression is not one number.** "Lifting progression" needs a definition: heaviest set per
movement over time? Estimated 1RM? Total volume per session? Recommend **per-movement best set**
as the headline (it is what lifters actually track) with **session volume** as a secondary line.

**Depends on:** `T3-3` strongly recommended first. **Blocks:** `T3-12`.

---

## 4. T3-11 — Variable-length cycles · `SHIPPED` 2026-09-12 (supersedes `T3-1`)

**Complexity: medium-high.** Touches the schema, the prompts, the onboarding UI, the plan screen,
and adds week-advancement logic that does not currently exist in any form.

**What:** the cycle length becomes a user choice at creation — "how many weeks?" — with a
**Not sure** option that asks the AI to recommend a length based on training goal, experience and
intended stimulus. Replaces today's hardcoded, purely decorative 4-week timeline.

**Systems touched:**
- **Onboarding** — new question, plus the "not sure" path (a small, cheap AI call of its own)
- **Schema** — `cycle_weeks`, `current_week`, and per-week plans. Today there is exactly one
  `current_plan` blob and no notion of a cycle at all
- **Prompts** — must become phase-aware for arbitrary N, not the hardcoded `"week": 1`. Phase
  boundaries scale differently for 4 vs 6 vs 12 weeks, and a deload in week 6 of 6 is a different
  instruction from a deload in week 4 of 4
- **Plan screen** — the timeline must render N nodes, not four hardcoded divs. Interacts with
  `T3-8`; do the bug fix first so this builds on correct markup
- **Advancement** — when every day in a week is complete, advance and generate the next week.
  Nothing like this exists today; `day.completed` is the only progress state

**Resolves `D3` and `D4`,** which have been open since the first audit:
- `D3` — is a cycle N distinct weekly plans, or one plan progressively loaded?
- `D4` — do we keep plan history, or only ever the current plan?

**Recommendation on `D3`:** distinct plans per week, generated one week ahead. Real periodisation
changes exercise selection, not just load, and it means a mid-cycle adjustment (`T3-13`) can
rewrite the upcoming week without touching completed ones. It costs one AI call per week rather
than one per cycle, which is cheap and already rate-limited.

**Recommendation on `D4`:** keep history. Once cycles are a real entity, "show me cycle 3" is
obviously valuable, and it is far cheaper to store from the start than to reconstruct later.

---

## 5. T3-12 — AI review of near- and long-term progress · `OPEN`

**Complexity: high, but mostly gated rather than intrinsically hard.** Once `T3-10` exists, this
is largely a prompt and an endpoint.

**What:** the AI can speak to progress over a week, a cycle, or a year — "you have added 40 lb to
your squat since March, and your consistency dropped in June."

**The architectural constraint:** a year of raw workout logs will not fit a context window at
sensible cost. **This endpoint must consume `T3-10`'s aggregates, not raw history.** That is the
whole reason `T3-10` is described as a data layer rather than a screen — the dashboard and the AI
read the same computed summary.

**Design note:** aggregates should be computed server-side and cached, not recomputed per request.
A year of training is not much data, but recomputing it on every AI call is waste that grows.

**Depends on:** `T3-10`. **Do not start before it.**

---

## 6. T3-13a — Journal becomes a capture log · `SHIPPED` 2026-09-12

**Complexity: low.** Contains a live bug fix.

**Reshaped 2026-09-12.** The original plan split Check-in into two agents, one read-only and one
able to change the programme. That split turned out to be unnecessary: **Adjust Program already
provides it, spatially.** It sits behind an icon on the Plan screen, away from everyday flow,
where it cannot be triggered by accident. The user was right that it is well placed.

Which exposes the real problem. **The Journal tab rewrites your plan today.** "Save & Recalibrate
Plan" POSTs to `/api/recalibrate-plan` on every save, so the casual reflection screen has exactly
the write power the deliberate one has — and warns you about it far less. That is a live silent-write
bug of the same family as everything Tier 1 fixed.

### What the Journal is for

Two activities were conflated, with different rhythms:

- **Capture** — frequent, fast, expects no answer. *"Left shoulder tweaked on incline."* *"Slept
  five hours."* It has to take eight seconds, in a gym, possibly offline.
- **Consultation** — occasional, deliberate. *"My shoulder has been off for two weeks, what should
  I do about pressing?"*

Merging them makes capture expensive. If every note triggers a coaching reply, you stop writing
notes — but the coach still needs to have read them. So: one tab, separate actions.

### Shape

- A single free-text field. No prompts, no categories, no energy/intentions split. An info dump.
- **Save writes a timestamped entry and makes no AI call.** Instant, free, works offline.
- The running log below it. Valuable with no AI involved at all — it is a training diary.
- Asking the coach is a separate action (`T3-13b`).

### Why notes matter more than they look

They have three consumers, and the least obvious is the most valuable:

1. The coach — immediate advice
2. The plan generator — already reads journal entries today
3. **Long-term review (`T3-12`)** — *"your left shoulder has come up six times since March, always
   on pressing days"*

Nothing else in the app captures that. Workout data records what was lifted; only notes record
that it felt terrible. A year of them is what makes a coach sound like it knows you rather than
reciting your numbers back. That argues for capture being cheap and frequent, not gated behind a
conversation.

Entries already carry `cycle_id` and `week_number` from `T3-14`, so temporal context is free.
Freeform text plus timestamps is enough — the model extracts meaning well, and asking the user to
tag things adds friction for little return.

### Work

- Migration **002**: add `note TEXT` to `journal_entries`, backfilling from the existing
  `energy`/`intentions` columns. Keep the old columns; do not drop data.
- `/api/journal` accepts a single `note`.
- Rewrite the Journal screen: one field, a Save that only saves, and the entry log.
- **Remove the `/api/recalibrate-plan` call.** The Journal gets no write access to programming.

**Note:** 002 is the first *data-preserving* migration. 001 could be destructive because the free
window was open; from here migrations carry real history forward. This is the mechanism from
`T3-14` earning its place.

---

## 7. T3-13b — Read-only AI coach · `OPEN`

**Complexity: medium-high.** New interaction model and new persistence, but half the original
scope now that the agent split is handled by layout.

**What:** a chat that knows your programme and history and answers questions about it. Questions
about this week, a specific movement, technique, why the programme looks the way it does.

**It cannot change anything, and says so usefully.** Asked for a change, it answers and names where
to act: *"Go into Adjust Program and ask to swap back squats for a few weeks."* Naming the place is
the point — refusing alone teaches the user nothing about where the capability lives.

**What it reads:** current cycle and week plan, recent workout history, all journal notes, and
`T3-10` aggregates once they exist.

**Dependency change:** this **no longer requires `T3-10`**. History and notes both exist today;
aggregates make the coach better, not possible. `T3-13b` can move ahead of the Metrics rewrite if
the coach is wanted sooner.

**Constraints:**
- **Cost scales with conversation length**, unlike every other AI call in the app. The current caps
  (10 per 15 min, 40 per day) are sized for one-shot generation and would be exhausted in a single
  real conversation. Chat needs its own budget.
- **Context per turn needs a cap.** Shipping a year of raw sets every message is the failure mode;
  `T3-10`'s aggregates are the fix.
- Conversation history is new data and needs a table.

---

# Phase 2 — Build order

**Superseded the complexity ranking on 2026-09-12** at the user's direction: order by design and
dependency, not by how hard each piece is. `D10` was answered yes — purge and redesign — which
makes the schema the keystone and changes what sensibly comes first.

Two reorderings fall out of that, and both are the opposite of the complexity ranking:

- **`T3-9` (swap) moves later.** It writes sets. Building it against the current blob and again
  against the new tables is the exact rework `D10` exists to avoid.
- **`T3-11` (cycles) moves ahead of `T3-10` (metrics).** After the purge there is no plan and no
  history. A metrics dashboard with nothing to display cannot be built or judged, and no history
  accumulates until there is a cycle to train against. Cycles first is forced by reality, not
  preference.

## Order

| # | Item | Why here | Gate |
|---|------|----------|------|
| 1 | `T3-8` visual bug | ✅ **SHIPPED** 2026-09-12 | none |
| 2 | **`T3-14` schema redesign** | ✅ **SHIPPED** 2026-09-12 | `D10` ✅ |
| 3 | `T3-11` variable cycles | ✅ **SHIPPED** 2026-09-12 | `T3-14` ✅ |
| 4 | `T3-9` exercise swap | ✅ **SHIPPED** 2026-09-12 | `T3-14` ✅ |
| 5 | `T3-10` metrics + aggregates | ✅ **SHIPPED** 2026-09-13 | `T3-14` ✅, `T3-11` ✅ |
| 6 | `T3-13a` journal capture log | ✅ **SHIPPED** 2026-09-12 | `T3-14` ✅ |
| 7 | `T3-13b` read-only coach | Needs history and notes; aggregates optional | `T3-13a` |
| 8 | `T3-12` long-term AI review | Reads `T3-10` aggregates, not raw logs | `T3-10` |

Steps 3 and 4 are what get the app usable again after the purge. Steps 5-7 are what make it good.

---

## T3-14 — Phase 2 schema redesign · `SHIPPED` 2026-09-12 (absorbs `T3-3`)

Replaces the two-JSONB-blob model. **Destructive: existing user data is purged**, agreed
2026-09-12 on the basis that the only user is the developer, who intends to rebuild as a 6-week
cycle regardless.

### Why the current model blocks everything downstream

`user_data` holds one `current_plan` blob and one `workout_journal` blob per user. That means no
cycle entity, no plan history, every save rewrites everything, and weight and reps are free text.
Metrics cannot be queried, progress cannot be plotted, and the AI cannot be given a compact view
of a year.

### Target shape

```sql
cycles          -- one row per training cycle
  id, user_id, name, goal, experience_level, equipment, training_days,
  extra_details, total_weeks, current_week, status, created_at, completed_at

week_plans      -- D3: N distinct plans, one per week, generated a week ahead
  id, cycle_id, week_number, phase, plan JSONB, status, generated_at
  UNIQUE (cycle_id, week_number)

workouts        -- one row per completed session
  id, user_id, cycle_id, week_number, day_index, day_name,
  started_at, finished_at, duration_seconds

workout_sets    -- the row that makes metrics and long-term AI possible
  id, workout_id, exercise_name, exercise_order, set_number,
  weight_value NUMERIC, weight_unit TEXT, is_bodyweight BOOLEAN,
  reps_value INTEGER,
  weight_raw TEXT, reps_raw TEXT,     -- exactly what the user typed
  swapped_from TEXT,                  -- T3-9 substitution flag
  logged_at

journal_entries -- check-in reflections, finally server-side (fixes T3-2)
  id, user_id, cycle_id, week_number, energy, intentions, created_at
```

`chat_messages` arrives with `T3-13`; not built now, but the shape above leaves room for it.

### Design notes

**Keep the raw strings.** `weight_value` is parsed for querying; `weight_raw` preserves the
literal input. Storing only the parse means a parser bug silently rewrites training history —
the same class of failure as `T1-2`, where the app recorded numbers the user never entered. The
normalised column is a convenience; the raw column is the record.

**`plan` stays JSONB.** Exercises within a week are read and written whole and never queried
across rows. Normalising them would add joins for nothing. Sets are different: they are exactly
what gets aggregated, so they become real columns.

**`week_plans` keeps history** (`D4`), so an adjustment in `T3-13` can rewrite an upcoming week
without touching completed ones, and `T3-12` can look back across cycles.

**`cycles.current_week` drives advancement,** replacing today's `day.completed` flags as the only
notion of progress.

### Do the migration mechanism now, not later

The **Constraints** section notes that `initDB()` uses `CREATE TABLE IF NOT EXISTS` and therefore
cannot alter an existing table. Purging sidesteps that once. It will not be available again.

So `T3-14` should also add a minimal migration runner — numbered SQL files plus a
`schema_migrations` table recording what has been applied. Perhaps 40 lines. Without it the same
wall is hit at `T3-13` (adding `chat_messages`), except by then there is real data behind it.

**This is the part of `T3-14` that outlasts `T3-14`.** The free window is being spent either way;
spending it on a mechanism rather than only on tables is what stops this recurring.

### Open questions

- Units: store everything in one canonical unit, or per-set with a user preference? Recommend
  per-set `weight_unit` with a display preference, since converting on write loses fidelity and
  lifters do not think in converted numbers.
- Does `workouts` need a `notes` field for per-session comments? Cheap now, awkward later.


---

# Phase 3 — It is a program generator, not a workout generator · **CORE SHIPPED 2026-09-20**

Added 2026-09-20, after the user corrected the founding premise. This is the most important
entry in this document: several things built so far are shaped by the wrong model.

## The premise

> It is not a "workout generator", it is a **program generator**. It generates a full cycle of
> workouts over X weeks, each one focusing on progression. It knows what you did last week, the
> week before that. It knows when to load and deload, and what the next cycle should look like.

## What is actually built, and why it falls short

Every week is produced by an independent `/api/generate-plan` call. It receives the goal,
equipment, workout history, journal entries and a phase label — and improvises a week.

Nothing carries the **design** of the programme from one week to the next. Week 4 is not
week 4 of anything; it is a fresh week that happens to be labelled "Peak". That is a workout
generator with a counter attached.

Three symptoms already seen, all the same root cause:

1. **Movement names drifted** between weeks, splitting one climbing lift into several
   one-session movements so nothing charted. Patched by instructing the model to reuse names —
   **a prompt-level workaround for a structural problem.** If movements are chosen once for the
   whole programme, drift is not possible.
2. **Deloads were a hope, not a plan.** The prompt says "this is a deload week" and trusts the
   model to have left something to deload from.
3. **Progression cannot be explained.** Nobody can say *why* the weight went up, because the
   reason lives in a prompt that has already been discarded.

## The shape it should be

A **programme** is designed once per cycle and stored. A **week** is rendered from it.

```
PROGRAMME (designed once, per cycle)
  name, goal, totalWeeks, rationale
  split:       the days, and the movements in each      <- fixed for the cycle
  progression: the rule (e.g. double progression, +5 lb at top of range)
  weeks[]:     per-week phase, set count, intensity target, intent

WEEK N (rendered)
  = programme.split
  + programme.weeks[N]
  + what was actually lifted so far
```

Movements are chosen **once**, at programme design. Swaps (`T3-9`) edit the programme, which is
already how persistent swaps behave — that mechanism was built for this model before the model
existed.

### Rendering a week should mostly not need a model call

Given the programme's rule and the last week's logged sets, next week's prescription is a
calculation, not a judgement. `Squat 3x8 @ 185, all sets at the top of the range → 3x8 @ 190`
is arithmetic.

That makes weeks **instant, free, and auditable** — the app can show *why* a weight moved,
instead of a number a model produced for reasons nobody can inspect. It is the same principle
that drove `T3-10`: compute what can be computed, and do not let the model invent data.

Keep the model for the things that genuinely need judgement:
- **Designing the programme** — once per cycle
- **Adapting it** — "my back is sore", a journal entry flagging fatigue, a missed week
- **Designing the next cycle** from the last one

### The end of a cycle is the interesting moment

A finished cycle is finished. Extending it is incoherent: a block that has peaked and deloaded
has nowhere to go. Adding weeks to the end produces a tail with no plan behind it — which is
why the "Add More Weeks" button was removed the moment it was proposed.

What should happen is that **cycle N+1 is designed from cycle N**: what was run, what actually
got lifted, what the journal said, what stalled, what to focus on next. That is where `T3-12`
(long-term review) belongs — not as a separate "insights" feature, but as the input to the next
programme.

## What this changes

| Item | Effect |
|---|---|
| `T3-9` swaps | Already correct. Persistent swaps edit the programme; that is the model. |
| `T3-10` metrics | Already correct, and becomes the input to next-cycle design. |
| `T3-12` long-term review | **Reframed.** Not an insights screen — the brief for the next programme. |
| `T3-13b` coach | Unchanged, and gets much better: it can explain the programme, not just the week. |
| Naming guidance | Becomes a **belt** over a structural fix, rather than the only defence. |
| Week generation | Reworked: render from the programme instead of regenerating from scratch. |

## Open questions

- **Does the user see the whole programme up front?** Seeing all six weeks is motivating and
  makes the arc legible. It also invites treating it as fixed when the point is that it adapts.
  Leaning: show the arc (phases, movements, weekly intent) but not fabricated future loads,
  since those genuinely depend on what happens.
- **How much of week rendering is deterministic?** Leaning heavily deterministic for load
  progression, with the model consulted when the journal or a missed session says something
  changed.
- **What happens to a cycle abandoned mid-way?** It should still inform the next programme —
  "you stopped in week 3 twice now" is a real signal.

## Migration

The current schema already carries most of this. `cycles` holds the cycle, `week_plans` holds
per-week plans, and `T3-9` already stores cycle-level substitutions. What is missing is the
programme itself — the split, the progression rule and the weekly arc — which is one more JSONB
column on `cycles` and a migration that adds it.

Existing cycles have no programme. They should be allowed to finish under the current
week-at-a-time behaviour rather than being retrofitted.


## Phase 2 design rationale

Reasoning behind D6-D10. **Current status is tracked in `Decisions & open questions` below** --
that table is authoritative; this one records why each recommendation was made.

| # | Question | Blocks | Recommendation |
|---|----------|--------|----------------|
| D6 | Does an exercise swap persist beyond the session? | `T3-9` | Session-only, with an opt-in "rest of cycle" |
| D7 | Swap alternatives: static map or AI? | `T3-9` | Static — instant, offline, free |
| D8 | Chart: hand-rolled SVG or a library? | `T3-10` | Hand-rolled SVG — CSP-friendly, works offline |
| D9 | Does the adjustment agent apply changes directly? | `T3-13` | **No** — preview and confirm, always |
| D10 | Take the schema foundation (`T3-3`) early, while purging is free? | `T3-10`, `T3-11` | **Yes** — it will never be cheaper |


## Decisions & open questions

Cross-cutting things to settle before they force rework.

| # | Question | Why it matters | Status |
|---|----------|----------------|--------|
| D1 | Is this single-user, friends-only, or public? | Drives `T2-3`, registration policy, and how much `T3-3` matters | **Unanswered** |
| D2 | Is the checkmark authoritative, or are typed values? | Blocks `T1-2` | ✅ **Decided 2026-09-12** — checkmark only |
| D3 | Is a "cycle" N distinct weekly plans, or one plan progressively loaded? | Blocks `T3-11`, shapes `T3-14` | ✅ **Decided 2026-09-12** — N distinct plans, generated a week ahead |
| D4 | Keep plan history, or only ever the current plan? | Schema decision; shapes `T3-14` | ✅ **Settled 2026-09-12** — keep, forced by `T3-12` |
| D5 | Does the clone live inside OneDrive or outside it? | Blocks `T1-0` | ✅ **Decided 2026-09-12** — outside |
| D6 | Does an exercise swap persist beyond the session? | `T3-9` | ✅ **Decided 2026-09-12** — user picks at swap time: this session / this and future |
| D7 | Swap alternatives: static map or AI? | `T3-9` | ✅ **Decided 2026-09-12** — static map |
| D8 | Chart: hand-rolled SVG or a library? | `T3-10` | ✅ **Decided 2026-09-12** — hand-rolled SVG (delegated) |
| D9 | Does the adjustment agent apply changes directly? | `T3-13` | ✅ **Decided 2026-09-12** — yes, auto-apply for now; revisit after dogfooding |
| D10 | Take the schema foundation early, while purging is free? | `T3-10`, `T3-11` | ✅ **Decided 2026-09-12** — yes, purge and redesign |

### D2 — resolved

**A set is logged if and only if its box is checked.** Typed values in an unchecked row are never
written, under any circumstance. The app never infers completion from the presence of data.

Rationale: inferring intent from typed numbers would let unconfirmed sets into the history, which
is a softer version of the bug being fixed. The data feeds progressive overload, so an
unambiguous rule beats a forgiving one. The forgetfulness risk is handled at the exit point
instead — `finishWorkout()` warns when unchecked rows contain values and makes the user resolve
it, rather than guessing on their behalf. Full UX in `TIER1_PLAN.md` → `T1-2`.

**Principle worth carrying forward:** when a rule governs data the AI reads back, prefer the
unambiguous rule and put the forgiveness in the UI.

---

## Shipped

_Nothing yet._

---

## Log

### 2026-09-12 — Initial audit

Full read of all 6 source files. No code changes made.

Catalogued 16 issues across three tiers. Two findings stand out as genuinely destructive because
neither announces itself — `T1-1` (new-device login silently wipes lift history) and `T1-2`
(unchecked sets get logged at the suggested weight). Both corrupt the workout history, which is
the single dataset the entire progression feature reads from. An inflated history makes Gemini
prescribe heavier loads, so the failure mode isn't just lost data — it's bad programming
delivered with confidence.

Found during planning, not in the original audit: logout never clears `currentWorkoutPlan` or
`workoutJournal` from localStorage. Combined with the boot-sequence bug, user B logging in on a
shared browser can push user A's history into their own account. Folded into `T1-1` — same root
cause, same fix.

Also confirmed this working copy has no `.git`. Logged as `T1-0`; it blocks shipping anything.

### 2026-09-12 — Toolchain check + D2 decided

**D2 resolved** in favour of the stricter rule (checkmark only, warn on exit). See above.

**Git environment surveyed.** `gh` is not installed, but it isn't needed — the repo is public and
`git ls-remote` reaches `main` at `c12df02` anonymously. Findings:

| Check | Result |
|---|---|
| `git` | 2.52.0.windows.1 ✅ |
| Repo public / reachable | ✅ |
| Git Credential Manager | ✅ configured system-wide — browser prompt on first push |
| `user.name` / `user.email` | ❌ unset globally — **commits will fail until set** |
| Node / npm | v25.2.1 / 11.6.2 ✅ |

Git identity must be configured before the first commit. Clone location still open (`D5`).

### 2026-09-12 — T1-0 done: real working copy established

Cloned to `C:/Users/gowen/Code/Progressive-Strength`, outside OneDrive per `D5`. Repo-local git
identity set (`gowenid-rgb` / `gowenid@gmail.com`) via `--local`, so the global config is untouched.
Branch `fix/tier-1-data-integrity` created off `main` @ `c12df02`.

**Verified the zip held no unreleased work.** A naive `diff -r` reported every single file as
differing, which looked alarming. It was `core.autocrlf` — the zip is LF, the checkout is CRLF.
Comparing with `
` stripped shows all ten source files byte-identical. Nothing was lost.

Worth remembering: on this machine any zip-vs-clone comparison will look 100% different until
line endings are normalised. Don't panic at that again.

`DEV_JOURNAL.md` and `TIER1_PLAN.md` moved into the repo and are untracked pending first commit.

**Still outstanding on `T1-0`** (needs Railway console access, can't verify from here):
- Confirm Railway deploys from `main` on this repo, and whether it auto-deploys on push.
- Confirm `JWT_SECRET`, `DATABASE_URL`, `GEMINI_API_KEY` are all set. `T1-3` is blocked on the
  first of these — deploying the fail-fast guard without it set will crash-loop the app.
- Take the `pg_dump` backup before any code change.

---

## T1-5 — Rotate exposed production credentials · `OPEN`

**Not a code issue.** Operational, but urgent enough to sit in Tier 1.

On 2026-09-12 the Railway Variables pane was shared as a screenshot, exposing the live values of
all three service variables. Values are deliberately **not** recorded in this repo.

| Credential | Practical exposure | Priority |
|---|---|---|
| `GEMINI_API_KEY` | Usable by anyone from anywhere. Direct billing risk. | **1st** |
| `JWT_SECRET` | Forge a token for any `user.id`. Needs the app URL, which is public. | **2nd** |
| `DATABASE_URL` | Password is live, but `postgres.railway.internal` is private-network-only. | **3rd** |

**Open check:** confirm no public TCP proxy is enabled on the Postgres service
(Railway → Postgres → Settings → Networking). If one is, `DATABASE_URL` is reachable from the
open internet and jumps to priority 1.

**Sequencing win:** rotating `JWT_SECRET` invalidates every outstanding token and logs all users
out once. `T1-3` is already a deploy. Do the rotation in that same deploy and the forced logout
happens once, not twice.

**Broader note:** the app has no secret-scanning and no `.env.example`, so there's nothing
signposting which values are sensitive. `.env.example` is being added as part of `T1-3`.

---

### 2026-09-12 — Railway env verified, T1-0 closed

All three service variables confirmed present: `DATABASE_URL`, `GEMINI_API_KEY`, `JWT_SECRET`.

**`T1-3` is unblocked and lower-risk than feared** — `JWT_SECRET` is set, so production is *not*
currently running on the hardcoded fallback, and adding the fail-fast guard will not crash-loop
the app. The vulnerability was latent (one unset variable away), not active.

Filed `T1-5` — the screenshot that confirmed this also exposed all three live values.

Still outstanding before any deploy: confirm Railway deploys from `main` / auto-deploys on push,
and take the `pg_dump` backup.

### 2026-09-12 — T1-3 and T1-4 written (server-side), uncommitted

Both server-side fixes are written on `fix/tier-1-data-integrity`. Nothing committed, nothing
deployed.

**T1-3 — verified locally, three tests pass:**
- No `JWT_SECRET` → clean message, `exit 1`, no stack trace.
- Valid `JWT_SECRET` → server boots normally.
- Secret under 32 chars → warns but starts.

New `config.js` owns dotenv loading and validation; `middleware.js` and `authRoutes.js` import
from it. Grep confirms zero surviving references to the fallback string and no direct
`process.env.JWT_SECRET` reads outside `config.js`. Also removed a duplicate `dotenv.config()`
call — server.js and config.js were both loading it.

**T1-4 — code complete but NOT verified.** Railway Postgres is bound to
`postgres.railway.internal`, which is unreachable from this machine, and there is no local
Postgres. Syntax checks pass and the SQL is straightforward, but *no upsert has actually been
executed against a database.* Do not treat this as done. Verification needs either a local
Postgres container or a deploy to a non-production environment.

This is the concrete cost of having no staging environment — already noted under
**Constraints**, now biting.

**Incidental:** `npm install` added `"peer": true` to the `pg` entry in `package-lock.json`.
Lockfile metadata normalisation, unrelated to these fixes. Left in rather than hand-reverting.

### 2026-09-12 — Server-side Tier 1 committed and pushed

Two commits on `fix/tier-1-data-integrity`, pushed to origin:

- `be3b301` docs: dev journal + Tier 1 plan
- `180f21f` fix(server): T1-3 and T1-4

**Why Railway "wasn't auto-deploying": there was nothing to deploy.** `origin/main` and local
`main` were both still at `c12df02` — the same commit the zip was cut from — and zero commits had
been made. Railway watches for new commits on the connected branch and was correctly doing
nothing. Auto-deploy was never broken; it had never been given input.

Pushing a *branch* should still not deploy, since Railway deploys from `main`. If the Deployments
tab shows activity from this push, the service is configured to build all branches, which is worth
knowing before the merge.

Git push worked with no credential prompt — GCM already had GitHub credentials cached.

**Unverified code is now on a branch, not in production.** `T1-4` still has never run against a
database. Merging to `main` is what deploys it.

### 2026-09-12 — All Tier 1 code complete and tested; a near-miss caught in the process

`npm test` = **59 assertions, all passing.** `T1-4` is no longer unverified: PGlite runs real
PostgreSQL 18 in-process (WASM, no Docker), and the tests drive the actual `db.js` with `pg`
swapped for a PGlite-backed pool. Schema and upsert SQL are read out of the source files, so the
tests cannot drift from the implementation.

Assertions deliberately read `result.rowCount` — the property `server.js` actually checks — after
confirming PGlite exposes both that and `affectedRows`. An earlier draft accepted either, which
would have masked a shape mismatch between PGlite and node-postgres.

**The important find: the `T1-1` fix was itself a rollout hazard.**

The original bug wiped the server journal on new-device login. But the old boot sequence also
re-uploaded whatever the *first* device still held — so that device frequently kept the only
surviving copy. Hydrating strictly from the server, which is correct in general, would have
cleared that copy on first load after deploy and completed the data loss for exactly the users
the bug had already hurt.

`hydrateFromServer()` now refuses to overwrite a populated local journal with an empty server
one, and boot pushes the stranded copy back up instead — the single case where boot writes to
the server. It cannot leak across accounts, because `clearLocalSession()` runs at every session
boundary, leaving nothing to rescue when a different user signs in. Asserted explicitly.

**Worth generalising:** a fix that changes which copy of the data is authoritative needs to be
assessed against the state the *old bug* left behind, not just against a clean system. Apply this
to `T3-3` when the journal is normalised.

**Branch state:** `fix/tier-1-data-integrity` is 5 commits ahead of `main`, all pushed. Nothing
deployed. Merging to `main` is what ships it.

**Still outstanding and only doable in the Railway console:** rotate `GEMINI_API_KEY` (`T1-5`),
and confirm a database backup exists before the merge.

---

### 2026-09-12 — Tier 1 deployed to production; T2-2 through T2-5 done

**Tier 1 is live.** Merge `bf46038` -> Railway deployment `29a718fb`, Active. Logs show
`Database initialized successfully` and no `FATAL`, so `config.js` validated cleanly and the
upsert path is running against real Postgres. **The GitHub -> Railway auto-deploy link works** —
it fired on the push to `main`, answering the question the branch push could not.

Verified live, read-only: homepage 200; the new client code is genuinely served
(`clearLocalSession`, `hydrateFromServer`, `collectWorkoutRows`, the rescue warning all present;
`input.placeholder` and `fallback-secret` both absent); no token -> 401; garbage token -> 403; and
**a token forged with the old public fallback secret -> 403**, confirming the forgery path is shut.

The `pglite` devDependency did not affect the build — Railway installs with production config, so
dev dependencies are skipped. That earlier concern was unfounded.

**T2-2 resolved, and my original suspicion was wrong.** `ai.interactions.create()` is a real
method on `@google/genai` 2.21.0, and `gemini-3.8-flash` is a real model — confirmed against the
live model list, which returned 50 models including it. Nothing was broken.

The one genuine defect was the response read: `response.outputText || response.output_text ||
response.text`. Only `output_text` exists on the `Interaction` type. The other two operands were
always undefined, so an SDK change would have yielded `undefined` and thrown deep inside
`JSON.parse` with a useless message. Replaced with a single `readModelText()` that fails loudly
and logs the actual response keys.

**Found while reading the SDK types — a much better fix for `T2-1`.** The API supports
schema-enforced JSON:

```js
response_format: { type: 'text', mime_type: 'application/json', schema: { ...JSON Schema... } }
```

That removes the entire failure class `T2-1` describes: no markdown fences to strip, no
prompt-begging for raw JSON, and shape guaranteed by the API rather than by hope. It supersedes
the regex-extraction approach originally proposed. Not yet implemented — it changes the request
shape and wants a live call to confirm, which needs a key.

**T2-3 shipped.** `rateLimits.js` adds a burst cap (10 / 15 min) and a daily cap (40 / 24h) on the
three AI routes, keyed by **user id** rather than IP — these sit behind auth, and IP keying would
punish shared NATs while being trivial to evade. Auth routes get an IP-keyed limiter (20 / 15 min),
since those genuinely have no user yet. All tunable via env.

**T2-4 shipped, and hardened past the original plan.** `/api/models` is behind `authenticateToken`
and now **fails closed**: it requires `NODE_ENV === 'development'` rather than merely being absent
in production, because we cannot rely on `NODE_ENV` being set everywhere. First draft had it
backwards and would have left the route live wherever that variable was unset.

**T2-5 shipped.** An `/api` 404 handler mounted above the SPA catch-all returns JSON, so a wrong
endpoint no longer returns `index.html` with a 200 for the client to choke on.

**Test suite is now 76 assertions across three files.** The new `test/ratelimit.test.js` boots the
real server in-process on an ephemeral port and drives it over HTTP, so middleware *ordering* is
genuinely exercised rather than assumed — it needs neither a database nor a Gemini key, because
every route under test must reject before reaching either.

**`T1-5` (rotate `GEMINI_API_KEY`) is still open.** Rate limiting caps the damage but does not
revoke the exposed key. Requires Google AI Studio access.

### 2026-09-12 — Tier 2 deployed and verified live

Merge `be84e5e` deployed. Verified against production, read-only:

| Check | Result |
|---|---|
| homepage | 200 |
| `/api/models` anonymous | **401** (was an open proxy to the model list) |
| `/api/nonsense` | **404 JSON** — `{"error":"Unknown API endpoint: GET /api/nonsense"}` |
| `/deep/spa/link` | 200, SPA still served |
| `/api/user/data` no token | 401 |

The `/api/nonsense` result is the visible proof of `T2-5`: that path previously returned
`index.html` with a 200.

Rate limits are live but deliberately not exercised against production — tripping them would
lock a real account out of plan generation for 15 minutes. They are covered by
`test/ratelimit.test.js` against a real in-process server instead.

**Rollback target for this deploy: `bf46038`** (Tier 1).

### 2026-09-12 — T1-5 Gemini key rotated; T2-1 implemented with schema enforcement

**`GEMINI_API_KEY` rotated** (confirmed by the user; not independently verified from here, since
verifying would have meant putting the key into this transcript). `JWT_SECRET` and `DATABASE_URL`
from the same screenshot are **still un-rotated** — lower urgency, not zero.

**`T2-1` done, using the approach found in the SDK types rather than the one originally planned.**
Three layers, outermost first:

1. `response_format: { type: 'text', mime_type: 'application/json', schema }` asks the API to
   guarantee conforming JSON — removing the problem at source instead of cleaning up after it.
2. `extractJsonObject()` finds the first balanced `{...}` by brace counting, for when layer 1 is
   unavailable or ignored. String-aware, so a `}` inside an exercise name like `Squat {3x5}`
   does not end the object early. Handles fences, prose preambles and trailing commentary
   without special-casing any of them — the old `startsWith('\`\`\`json')` check was defeated by
   a single leading newline.
3. A validator rejects responses that parse but are useless (`days: []`, an exercise with no
   name). The old code had no equivalent and would persist such a thing as the active plan.
   One retry follows any failure in layers 2 or 3.

**The `response_format` field is unverified against the live API** — confirming it needs a real
call, which needs a key. So it degrades: if the API rejects the request as a shape error (400 /
unknown field), the client logs it, disables the field for the process lifetime, and retries
without it. Worst case we are exactly as good as before; best case the failure class disappears.
Watch the deploy logs for `response_format rejected by the API` to find out which.

Prompts now say to **omit** `suggestedWeight` rather than send `null`, because `null` does not
satisfy `type: string` in the schema. The client already treats a missing value as bodyweight.

Extracted `aiClient.js` so this is testable without a key: `__setClientForTests()` injects a stub.
`test/aiclient.test.js` adds 32 assertions covering every malformed response shape that used to
produce a 500, plus the retry paths and the fallback. Suite is now **108 assertions across four
files**.

**Riskiest deploy so far** — it is the first change to the actual generation path. Generating a
plan in the live app is the real test.

### 2026-09-12 — Phase 2 scoped: six items ranked by complexity

Scope shifts from repairing silent data corruption to building the app's actual product. Six
items logged as `T3-8` through `T3-13`, ranked easiest first, with a dependency graph. `T3-1` is
superseded by `T3-11`; `T3-3` is promoted from a Tier 3 nice-to-have to a Phase 2 foundation.

**The one thing worth arguing about is sequencing.** The user is the only user and has agreed
data can be purged, which makes a clean schema redesign free *right now* and never again.
`T3-10` and `T3-11` both want schema changes, and building the metrics layer on today's JSONB
blobs means building it twice. Recommended `T3-3` as a foundation step ahead of `T3-10` even
though it breaks the easiest-first ordering. Logged as `D10`.

**Two findings while scoping:**

`T3-8` has a trap. `renderPlan()` rewrites `node.className` including `z-10` on every render, so
fixing the static HTML alone would look right until the first plan loads. The fix belongs on the
timeline *wrapper* as a stacking context, not on the nodes.

`T3-10` is not really a UI task. Weight and reps are stored as free text (`"225"`, `"BW"`,
`"100kg"`), so nothing can be summed or plotted until there is a parse-and-normalise layer. That
layer, not the dashboard, is the work — and it is what `T3-12` will read, since a year of raw
logs will not fit a context window affordably.

**One principle carried forward into `T3-13`:** the adjustment agent gets write access to the
user's plan, which is precisely the shape of every bug Tier 1 just fixed. It must preview changes
and require confirmation. Never silent. Recorded as `D9`.

### 2026-09-12 — Build order set by dependency; D3, D4, D7, D10 resolved

User agreed to the purge and redesign (`D10`), and directed that ordering follow design rather
than complexity. `D3` resolved as N distinct weekly plans generated a week ahead; `D7` as a static
alternatives map.

`D4` (keep plan history) is settled by implication rather than choice: requirement #2, an AI that
reviews progress across a year, is not possible without retained history. Recording it as forced
by the feature rather than as an open preference.

**Two items moved against the complexity ranking, both for the same reason:**

`T3-9` (swap) drops from second to fourth. It writes sets, so building it before the schema means
building it twice — the precise rework `D10` was meant to eliminate.

`T3-11` (cycles) moves ahead of `T3-10` (metrics). After the purge there is no plan and no
history; a metrics dashboard cannot be built or evaluated against an empty database, and no
history accumulates until there is a cycle to train against. This one is forced by reality rather
than chosen.

**`T3-14` opened for the schema redesign**, absorbing `T3-3`. Two decisions inside it worth
flagging:

*Keep the raw strings alongside the parsed values.* `weight_value` makes metrics queryable;
`weight_raw` preserves what the user actually typed. Storing only the parse means a parser bug
silently rewrites training history — the same failure class as `T1-2`. The normalised column is
a convenience; the raw column is the record.

*Build the migration runner as part of this work.* The purge sidesteps the
`CREATE TABLE IF NOT EXISTS` limitation exactly once. Without a real mechanism the same wall
arrives at `T3-13`, with real data behind it by then. That is the part of `T3-14` that outlasts
`T3-14`.

### 2026-09-12 — D6, D8, D9 resolved; T3-8 shipped

**`D6` — swap scope.** Decided: the user picks at swap time, **This session only** or **This and
future**, the latter replacing that movement everywhere it appears in the remaining plan. Better
than the opt-in version originally proposed, because it puts the consequence in front of the user
at the moment they choose rather than hiding it behind a checkbox. Implication for `T3-14`:
`workout_sets.swapped_from` records what happened in a session, but a persistent swap also has to
rewrite the stored `week_plans`, so `T3-9` touches plan data and not just logging.

**`D8` — charting. Delegated, decided: hand-rolled SVG.** Reasons, in order of weight:
- The CSP allows scripts from a short CDN allowlist only, so a library is another external
  dependency on a page that is otherwise self-contained.
- This is a PWA that should work offline. A CDN script is a network dependency at load; the
  service worker can cache it, but that is one more thing to get wrong.
- The app has a specific dark aesthetic driven by a custom Tailwind palette. Theming a charting
  library to match is usually more work than drawing the chart.
- Scope is small: one line chart plus stat cards. That is roughly 60 lines of SVG against a
  ~200KB dependency.

Honest tradeoff: hand-rolling means owning axis scaling, date bucketing and responsive behaviour.
**Revisit if** we later want zoom/pan, several chart types, or interactive tooltips across
series — at that point a library earns its weight.

**`D9` — adjustment agent applies changes automatically.** User's call, on the basis that they
are the only user and will flag it if it bites. Recorded as decided, not as an open risk.

Worth noting because it costs almost nothing: `D4` already keeps `week_plans` history, so an
adjustment can be made **undoable** rather than **preventable**. If auto-apply does become a
problem, the fix is a restore-previous-version button rather than a redesign of the interaction.
The safety property is reachable later without revisiting the decision now.

**Two `T3-14` details settled** (small, taken as routine calls — say if either is wrong):
- **Units:** per-set `weight_unit` with a display preference, not conversion on write. Converting
  loses fidelity, and nobody thinks in converted numbers.
- **`workouts.notes`:** included. Cheap now, awkward to add later.

**`T3-8` shipped.** The timeline wrapper gets `relative z-0`, creating a stacking context that
contains the W-nodes below the sticky header, and the header moves to `z-20` so the relationship
is explicit. The containment deliberately lives on the wrapper: `renderPlan()` rewrites each
node's `className` — including `z-10` — on every render, so a fix applied to the nodes would
survive exactly until the first plan loaded.

### 2026-09-12 — T3-14 shipped: Phase 2 schema, migration runner, append-only history

The keystone is in. `user_data` is gone, replaced by `cycles` -> `week_plans` -> `workouts` ->
`workout_sets`, plus `journal_entries`. **186 assertions across six suites**, including a new
end-to-end suite that drives the real Express app over HTTP against real PostgreSQL.

**Two bugs closed as a side effect, structurally rather than by guarding against them:**

- `T3-3` (last-write-wins) — there is no longer a request that can overwrite history. Finishing
  a workout POSTs one session to `/api/workouts` and inserts rows. `syncData()` sends the plan
  and nothing else.
- `T3-2` (`journalEntries` never synced) — check-ins now persist to `journal_entries` and
  hydrate like everything else.

**The tests caught a regression I introduced.** Changing `syncData()` to send only the plan
silently broke the boot-time rescue rule, which called it to restore history stranded on a
device — so the rescue would have restored nothing. That is the exact failure the rescue exists
to prevent, reintroduced by the refactor that was supposed to make it unnecessary. Now fixed:
the rescue appends each workout individually. **Worth remembering that the regression was
invisible in every other test; only the assertion written specifically for the rescue caught
it.**

**Found while writing the integration test: a real race.** `server.js` starts `initDB()` without
awaiting, so two instances booting together both read an empty `schema_migrations`, both apply
001, and the loser dies on a duplicate key — taking the instance down. One replica on Railway
today, so it would not have fired yet; it would have fired the first time the service scaled.
`migrate()` now takes a session-scoped `pg_advisory_lock`, so concurrent runners serialise.

**Also caught:** migration 001 referenced `users(id)` without creating it. Correct against the
deployed database, which already has the table, and broken on every fresh one — including the
test suite and any local dev database. 001 now creates it `IF NOT EXISTS`, so it is right in
both cases.

**A test-harness fidelity note worth keeping.** node-postgres sends a param-less query over the
SIMPLE protocol, which allows several statements in one string — that is how a whole `.sql` file
applies in one call. PGlite's `query()` always uses the EXTENDED protocol and rejects
multi-statement text. The shim routes param-less calls to `exec()` so the harness matches
production. Without that the suite would fail on SQL that works in production, or worse, pass on
SQL that does not.

**`test/db.test.js` was rewritten rather than deleted.** Its `user_data` upsert assertions
(`T1-4`) are obsolete — the table no longer exists — but registration atomicity still matters,
because a half-created account was what made the original silent-save bug reachable. The file
documents what retired and why.

**Not yet done, and the reason `T3-11` is next:** the schema supports N-week cycles, but the UI
and prompts still only ever produce week 1. `total_weeks` is honoured when a client sends
`cycleOptions`, and nothing sends it yet.

### 2026-09-12 — T3-11 shipped: cycles are real

Cycle length is the user's choice (2-16 weeks) with a **Not sure - recommend for me** button
that asks the AI. The timeline renders one node per week from the cycle's phase list, weeks
advance, and prompts are phase-aware. `T3-1` is finally fixed: the timeline was decoration for
the app's whole life.

**A note on expectations.** `T3-14` shipped a day's work that changed nothing visible, and the
user reasonably asked why the app looked identical. That was a framing failure on my part rather
than a surprise — infrastructure was exactly what it was — but worth remembering: when a change
is deliberately invisible, say so before shipping it, not after.

**The tests caught a real programming flaw, not a wrong expectation.** Phases were assigned by
comparing each week's position against fraction thresholds (`< 0.4` base, `< 0.75` build). It
read as a clean 40/35/25 split and was not: a 4-week cycle came out **base/base/build/deload,
with no peak week at all**, and an 8-week cycle got only one. For a feature whose entire purpose
is correct periodisation, that is the bug being shipped rather than fixed. Rewritten to compute
explicit week counts with a floor of one week per phase. Verified across every length from 2 to
16 - phases never move backwards, every cycle of 4+ weeks ends in a deload, and every phase gets
at least one week.

**The server owns the week number.** The prompt asks for week N of M, but `plan.week` is
overwritten with the server's value regardless of what the model returns. The model is being
asked to program a week, not to decide which week it is.

**Phases are computed server-side and shipped whole** in the cycle payload, so the timeline and
the prompt cannot disagree about what week 4 of 7 is. The alternative - duplicating the phase
function in the inline client script - would have drifted the first time either changed.

**Dense timelines collapse their labels.** Past 8 weeks the phase names are shown only where the
phase changes, and nodes shrink past 10. A 16-week cycle still fits a phone.

**Verified visually** at 375x812: the cycle length control, a 6-week timeline at week 3, a
12-week timeline at week 7, and the `Week 3 Complete -> Start Week 4` card.

Suite is now **221 assertions across seven files**.

**Still queued:** `T3-9` (swap), `T3-10` (metrics), `T3-12` (long-term review), `T3-13`
(two-agent check-in). The Metrics and Check-in screens the user asked about are `T3-10` and
`T3-13` - still untouched, and next after swap.

### 2026-09-12 — T3-13 reshaped: the agent split was already solved by layout

The two-agent Check-in is no longer the plan. Adjust Program, behind an icon on the Plan screen,
already separates deliberate programme changes from everyday use — the user pushed back that it is
well placed, and they are right. A second split inside the Journal would have rebuilt in software
a boundary the layout already draws.

**That reframing exposed a live bug.** The Journal's "Save & Recalibrate Plan" POSTs to
`/api/recalibrate-plan` on every save, so the casual reflection screen has the same write power as
the deliberate one and warns about it less. Same family as everything Tier 1 fixed, still in
production. Removing it is now the first piece of `T3-13a`.

**The design question "what is the Journal for" resolved to: capture, not conversation.** Writing a
note has to cost nothing — eight seconds, in a gym, possibly offline — or it stops happening. If
every note drew a coaching reply, note-taking would die while the coach still needed the notes.
One tab, two separate actions: Save is free and silent, asking the coach is deliberate.

**The observation worth keeping** is that notes have three consumers, and the long-term one
(`T3-12`) is the most valuable and least obvious. Workout data records what was lifted; only notes
record that it felt terrible doing it. That is the signal that makes a coach sound like it knows
someone. It is an argument for cheap frequent capture over structured prompting.

Split into `T3-13a` (capture log, small, includes the bug fix) and `T3-13b` (read-only coach).
**`T3-13b` no longer depends on `T3-10`** — history and notes already exist; aggregates improve the
coach rather than enabling it. It can move ahead of the Metrics rewrite if wanted sooner.

### 2026-09-12 — T3-9 shipped: mid-workout swaps

A **Swap** button on every exercise in the workout player. Alternatives come from a static
movement-pattern library (`public/exercises.js`, decision D7) so the picker opens instantly and
works offline, plus an **Enter your own** field. Scope is a deliberate second step (decision D6):
**Just this session** or **Rest of the cycle**.

**The "rest of the cycle" case needed more than a plan edit.** Rewriting the current week's
remaining days is the obvious half, but a week generated next Monday knows nothing about a swap
made today — so "this and future" would silently have meant "this week only" the moment the next
week was built. Migration 002 adds `cycles.substitutions`, and the plan prompt now carries a
STANDING SUBSTITUTIONS block. **002 is the first data-preserving migration**; the free window that
justified 001 dropping a table is closed.

Substitution rules are **replaced, not appended**, for the same `from` movement, and chains
collapse: swap A->B then B->C and the stored rule becomes A->C rather than a stale hop through B.
Otherwise the prompt slowly fills with contradictions.

**Completed days are never rewritten** by a persistent swap. They are history, not plan.

`swappedFrom` records the ROOT original across repeated swaps, so A->B->C still reports that C
replaced A. Without it the AI sees someone who quietly stopped doing pull-ups with no idea it was
an equipment constraint rather than a programming choice.

Swapping also **drops the old `suggestedWeight`** — it belonged to the previous movement, and under
the pre-`T1-2` rules it would have been logged as the fallback for an untouched set.

**Two bugs found by the tests, neither related to swapping:**

`schema.test.js` asserted the migration list equalled `['001_...']` exactly, so it broke the moment
a second migration existed. Now asserts inclusion and filename ordering.

More interesting: `getWorkoutHistory` and `getJournalEntries` ordered only by timestamp. Two
entries written in the same instant share `created_at`, making their order arbitrary — including
the order the "Prev" column walks. Adding 002 perturbed the timing enough to expose it. Both
queries now break ties on `id`. Latent since `T3-14`, nothing to do with this feature.

Suite is now **253 assertions across eight files**. Verified in the browser at 375x812: picker,
scope step, and the applied swap with its "Swapped from Pull Ups" badge.

### 2026-09-12 — T3-13a shipped: Journal is capture, and the recalibrate bug is gone

The Journal is one free-text field, a Save that only saves, and a timestamped log of previous
notes. **No AI call, and no write access to programming.** The `/api/recalibrate-plan` call is
removed: writing a reflection no longer rewrites the week.

Migration 003 adds `journal_entries.note`, backfilling from `energy`/`intentions` with
`concat_ws` and **keeping both old columns**. A data-preserving migration that leaves old writing
invisible has preserved nothing that matters, so `getJournalEntries` falls back to the old columns
when `note` is null, and there is a test for exactly that.

`/api/journal` still accepts `{energy, intentions}` as well as `{note}`. A PWA caches its own
shell, so a phone that has not refreshed is still running the old client — and silently failing to
save someone's notes is a bad way to find that out. Covered by a test that posts the pre-`T3-13a`
payload.

**Sequencing note worth keeping.** Asked whether to do the bug or the Metrics rewrite first, the
deciding argument was not "bugs first". Both items depend on accumulated data, but in opposite
directions: **Metrics consumes history, notes create it.** Every day the capture log is delayed is
context the coach and `T3-12` will never have, while every day Metrics is delayed makes it easier
to build and judge. Waiting works for one and against the other.

**A recurring process failure worth naming.** Three times now a patch script has failed partway and
the `&&` chain after it printed a reassuring "none (good)" from the `||` fallback — output that
looked like verification and was nothing of the sort. Same shape as the app bugs this project keeps
finding: a success message not backed by the thing it claims. Checks now run as separate commands.

Suite is now **266 assertions across eight files**. Verified at 375x812.

### 2026-09-13 — T3-10 shipped: Metrics is data

The Metrics tab no longer spends a model call to produce a paragraph. Workouts this
week/month/year/all-time, weight moved over the same periods, a progression chart per movement,
and a best-sets list.

**`metrics.js` is a pure function over rows with an injected clock.** No database, no `new Date()`
of its own. Period boundaries and unit conversion are then testable directly instead of by seeding
a database and hoping the calendar cooperates — the week-boundary cases in particular
(a Sunday session belongs to the *previous* week; a Monday reference date must not roll back seven
days) would have been miserable to pin down otherwise.

**This is the aggregate layer `T3-12` reads,** not just a screen. A year of raw sets will not fit
a context window at sensible cost, so the long-term review consumes the same computed summary the
dashboard renders.

**Progression is heaviest-set-per-session** (the open question from the last round). Chosen over
estimated 1RM, which is a model of a number rather than a number, and over session volume, which
silently changes meaning when set counts change. Volume is still shown, as a total rather than a
trend.

**Chart is hand-rolled SVG** (decision D8), about 50 lines. Two edge cases that would otherwise
produce a broken chart: a **flat series** divides by zero on the y-scale and draws along the axis,
so the range is padded and a plateau reads as a plateau; and **one session is a point, not a line**,
so movements with a single session are excluded from the picker rather than rendering an empty box.

**A known gap, deliberately not fixed today.** Bodyweight movements contribute no volume — the app
does not know what you weigh, and inventing a number would corrupt the history the AI reads — and
they have no "best set" in pounds, so they are absent from both volume totals and the best-sets
list. Someone doing a lot of pull-ups has real training that does not appear anywhere on this
screen. The fix is to track best *reps* for bodyweight movements as a separate series; logged as
future work rather than bodged in.

`/api/generate-recap` is now dead code — nothing calls it. Left in place rather than removed and
re-added, since `T3-12` is the same shape and will either rework or replace it. It stays
authenticated and rate-limited in the meantime.

Suite is now **313 assertions across nine files**. Verified at 375x812 with a realistic year of
data, plus the two-point and flat-line chart cases.

### 2026-09-13 — In-progress workouts survive a reload

Ahead of a week of solo testing. Everything about an active workout lived in memory and in DOM
inputs, so a reload lost the session outright: every weight, every rep, every checkmark, and the
timer. On a phone in a gym that is not hypothetical — the OS evicts backgrounded tabs, and a long
enough lock screen will do it. Same failure class as the rest of this project: silent loss of the
data the app exists to collect.

The workout is now snapshotted to `localStorage` on every keystroke, every checkmark and every
swap, and restored on boot. Details worth keeping:

- **Session-only swaps are captured in the snapshot.** They live only in memory, so without this
  a reload would put restored sets back under the original movement.
- **The original start time is preserved**, so the timer shows real elapsed time instead of
  restarting. The tick now also runs once before the interval — hardcoding `00:00:00` first
  flashed a zeroed timer for a second on resume, which looks exactly like the loss this prevents.
- **`activeWorkout` is in `SESSION_KEYS`.** Without that, the next person to log in on a shared
  phone resumes someone else's sets.
- **Six hours is the auto-resume limit.** Older than that and it asks before picking up, because
  a workout from two days ago is abandoned, not in progress. It is never discarded without asking.
- A day already completed elsewhere, or a snapshot pointing at a day the plan no longer has,
  clears rather than restoring.

Verified by an actual browser reload: values, checkmarks, the session swap and the timer all
came back. `test/resume.test.js` adds 29 assertions, written because this loss was **silent** —
nothing errored, the sets simply were not there — and because a later refactor could reintroduce
it the same way changing `syncData()` quietly broke the `T1-1` rescue rule.

Also removed the Journal's reference to a "coach". `T3-13b` is not built, and promising that
something reads your notes when nothing does is a claim the app cannot keep.

Suite is now **342 assertions across ten files**.

### 2026-09-20 — Two bugs from the first real test week

**1. The week did not roll over.** Finishing the last day showed a "Start Week 2" button and
waited to be tapped. The button worked — reproduced end to end and it rendered correctly — but
making someone hunt for it is the wrong design. The week is over; the next one is what they want.
`maybeAdvanceWeek()` now fires from `finishWorkout()` when every day is complete, shows a
"Building week N" state during the model call, and leaves the button as a fallback for the cases
auto-advance cannot cover (offline, or a failed generation worth retrying).

**2. Progression charts showed nothing. The maths was fine; the grouping was not.**

Reproduced against a real database first: a deadlift logged at 185 then 225 aggregated correctly,
`points=[185,225]`. So the arithmetic was never the problem. The failure is upstream —
**exercise names drift between weeks**, because each week is generated by a separate model call:

```
Deadlift              sessions=1  points=[185]
Barbell Deadlift      sessions=1  points=[225]
Barbell Bench Press   sessions=1  points=[135]
Bench Press (Barbell) sessions=1  points=[145]
trendable: []
```

Two climbing lifts became four one-session movements and nothing charted. Fixed at both ends:

- **Root cause:** the plan prompt now carries the movement names already in the user's history
  with an instruction to reuse them exactly. Stops new drift at the source.
- **Existing data:** `canonicalName()` groups by the SORTED SET of significant words, so word
  order and punctuation stop mattering while the word set still does.

**Where the fix deliberately stops.** `Deadlift` and `Barbell Deadlift` still do not merge,
because merging on subset would also merge `Bench Press` into `Dumbbell Bench Press` — charting
185 next to 60 and calling it a collapse. **Over-merging invents data the user never produced;
under-merging only shows less.** Given everything this project has been about, that is not a close
call. Equipment words are never stripped, and there are assertions pinning that.

Instead the split is made *visible*: merged spellings show as "also logged as ...", and when
nothing is trendable the screen now lists the one-session movements. Two entries that are
obviously the same lift is then a diagnosis rather than a mystery.

**3. Found while reproducing:** `POST /api/user/data` returned a cycle object without `phases`,
so `currentCycle.phases` went undefined after every save and the timeline silently dropped its
Base/Build/Peak labels until a reload. Not reported, not visible in any test, found only by
printing the actual response.

Suite is now **365 assertions across ten files**.

### 2026-09-20 — Naming discipline on both generation paths

Existing duplicate lifts are left alone by decision — not worth a risky retroactive merge. The
point is that it stops happening.

**A gap in what shipped an hour ago.** The naming guidance reached `/api/generate-plan` only.
`/api/recalibrate-plan` had none, so every "Adjust Program" request could rename every lift in
the plan it was asked to adjust — the same bug, through a door left open. Both paths now share
one `buildNamesBlock()` helper.

**Names now come from logged history AND the plan in hand.** History alone is not enough:
recalibrating week 1 before anything is logged has nothing to anchor to, and the model will
happily rename lifts in the very plan it was handed. For generation the previous week's plan is
included too, so week N+1 calls a movement what week N called it. The list is deduplicated —
otherwise a name that is both logged and planned appears twice and the list grows every week.

The instruction is now explicit rather than polite: reuse the name *character for character*,
with the two real failure cases named (`"Barbell Bench Press"` must not become
`"Bench Press (Barbell)"`, `"Deadlift"` must not become `"Barbell Deadlift"`), plus an explicit
allowance so genuinely new movements can still be named.

**`test/naming.test.js` inspects the prompt actually sent**, via a stub client that captures it.
That is the test that was missing: the previous round shipped prompt guidance with nothing
asserting it arrived, which is exactly how it reached one endpoint and not the other. Assertions
cover both paths, the deduplication, and the empty-history case.

Suite is now **379 assertions across eleven files**.

### 2026-09-20 — Why week 2 never appeared: two bugs, both mine

The user reported a completed week with no way to generate week 2. Auto-advance was not the
problem — the cause was upstream of it.

**1. Cycles could be created one week long, silently.** `POST /api/user/data` built its options
as `Object.assign({ totalWeeks: 1 }, cycleOptions)`. **`Object.assign` copies an undefined
property straight over the default**, so a client that omitted `totalWeeks` — which is every
client from before `T3-11` shipped the length picker — produced a one-week cycle.

A one-week cycle is *complete the moment its first week is logged*. `isLastWeek` is true, the
"Week 1 Complete → Start Week 2" card never renders, and there is no next week to advance to.
Permanently finished on week 1.

The timing is the damning part: after the `T3-14` purge I told the user to sign in and create a
new cycle. That was **before** `T3-11` added the length picker, so the cycle they have been
testing against was almost certainly created exactly this way.

Options are now built explicitly rather than merged over a default, and the length is clamped, so
this cannot recur. Cycles already at one week in the database are unreachable by that fix, hence:

**2. There was no way out.** Cycle length was fixed forever at creation, and the
"Cycle Complete" card's only button went to Check-in — which the `T3-13a` rewrite turned into a
notes-only screen. **I created that dead end and never revisited the card.** The sole escape was
the small RESET chip, which discards the plan.

Now: `POST /api/cycle/length` changes an active cycle's length (clamped, and never below the
current week), the cycle-complete card offers **Start a New Cycle** and **Keep Going — Add More
Weeks**, and the plan header reads "Week 1 of 6" instead of "Week 1". That last one matters on its
own: a one-week cycle and week 1 of six looked identical, which is why this stayed invisible.

**The test that would have caught it** reproduces the legacy row directly — writing
`total_weeks = 1` in the database, because clamping on write cannot reach data already stored.
Testing only the paths the current client takes would have missed it entirely.

Suite is now **399 assertions across eleven files**.

### 2026-09-20 — The founding premise was wrong in my head

The user pushed back on two things, and the second is the one that matters.

**"There should be no Add More Weeks."** Removed immediately. A cycle that has peaked and
deloaded has nowhere to go; bolting weeks onto the end produces a tail with no plan behind it.
The answer to a finished cycle is the next cycle, informed by the one just finished.

**"It is a program generator, not a workout generator."** Written up in full as **Phase 3**
above. Everything built so far generates each week independently and labels it with a phase;
nothing carries the *design* of the programme between weeks. Week 4 is not week 4 of anything.

The uncomfortable part is that **three bugs already fixed were symptoms of this**, and I treated
each as its own defect:

- Movement names drifting between weeks — patched with a prompt instruction. If movements are
  chosen once for the whole cycle, drift cannot happen. The prompt fix is a workaround for a
  structural problem.
- Deloads that were a hope rather than a plan.
- Progression nobody can explain, because the reasoning lived in a discarded prompt.

Also worth recording: `T3-9`'s persistent swaps already edit "the plan for the rest of the
cycle", which is the programme model in miniature. That mechanism was built for an architecture
that did not exist yet, which is a sign the model was right and the framing was not.

**Still unresolved: the user states their cycle was created as 6 weeks**, which contradicts the
one-week diagnosis from earlier today. Need the plan header text to settle it — it now reads
"Week N of M" precisely so this is answerable at a glance.

### 2026-09-20 — Phase 3 core shipped: programmes are designed, weeks are rendered

Confirmed first: the header read **"Week 1 of 1"**. The six weeks the user chose were name-only.
`Object.assign` copied an undefined `totalWeeks` over the default, and nothing ever tracked the
cycle. That is now impossible, and more importantly it no longer matters — the cycle is created
server-side as part of designing the programme, not assembled from whatever the client happened
to send.

**What shipped.** Migration 004 adds `cycles.program`. `POST /api/generate-program` asks the
model for the ARC once per cycle — the split, the movements, the progression rule, and what each
week is for — then stores it, creates the cycle, and renders week 1. Advancing renders the next
week **from the programme with no model call at all**, asserted by a test that counts them.

**Progression is now arithmetic, and it explains itself.** Double progression: hold the load
until every set reaches the top of the rep range, then add 5 lb upper / 10 lb lower. Each
prescription carries its reason, shown in the app:

> *Up 5 lb — you hit 8 reps on every set at 185 lb.*
> *Hold 185 lb — got 7 of 8 reps. Add weight once all sets reach 8.*

That is the difference between a programme and a generator. Nobody could previously say why a
weight moved, because the reasoning lived in a discarded prompt.

**Three failure modes closed structurally rather than by prompt:**

- **Name drift is impossible.** Movements are chosen once and reused every week. A test asserts
  week 1 and week 6 contain identical movements. The naming instruction added earlier today is
  now a belt over a structural fix.
- **Deloads are real.** `setAdjustment` cuts sets and the prescription drops ~15% off the top
  set, rather than the prompt saying "deload" and hoping.
- **A programme that does not cover every week is rejected** at validation. A six-week cycle
  describing four weeks used to be perfectly acceptable output.

**The next cycle reads the last one.** Programme design receives previous cycles — including
**abandoned** ones, deliberately, since stopping in week 3 twice is a real signal — plus the
full history and journal entries.

**What is deliberately still a model call:** designing the programme, and adapting it through
Adjust Program. Rendering a week is not one. Cheap, instant, inspectable.

**Cycles created before 004 have no programme** and fall back to the old week-at-a-time
behaviour rather than being retrofitted with a design that was never followed.

Suite is now **450 assertions across twelve files**.

### 2026-09-20 — The client half of Phase 3 was never written to disk

The server half deployed fine. The client half did not, and the failure was silent in an
instructive way.

The patch script applied five edits in memory and wrote the file **once at the end**. A sixth
edit failed its anchor, the script aborted, and the write never ran — so every "patched:" line
it printed was a lie about the filesystem. Worse, `npm test` stayed green: no suite exercises
the client's call path, so nothing noticed the app was still calling the old endpoint.

It only surfaced because the post-deploy check grepped the deployed HTML for the new code and
found none. **The grep caught what twelve test suites could not.**

**This is the fourth time in this project that a script has reported success it had not
achieved** — the `&&`-chain `|| echo "none (good)"` masking earlier failures, twice, and now
this. Same shape as the application bugs the whole project has been about: a success message
not backed by the thing it claims. The script now writes after every individual patch, and
verification greps the file on disk rather than trusting the script's output.

Client half now in and verified in a browser: the header reads "Week 3 of 6", the timeline shows
the full arc with phases, and the programme card expands to show the rationale, the progression
rule in plain language, and every week's intent with the current week highlighted.
