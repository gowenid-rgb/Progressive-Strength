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
- **No test framework, no CI.** Every change is verified by hand. Manual test scripts belong in
  the plan for each fix.
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
| T1-1 | Session lifecycle wipes history and leaks data between accounts | `PLANNED` |
| T1-2 | Workout logger records sets the user never performed | `PLANNED` |
| T1-3 | `JWT_SECRET` falls back to a hardcoded public value | `IN PROGRESS` — code done, verified |
| T1-4 | `user_data` save is `UPDATE`, silently no-ops when row is missing | `IN PROGRESS` — code done, **unverified** |
| T1-5 | Production credentials exposed in a screenshot — rotate all three | `OPEN` |

---

## Open Issues — Tier 2 (reliability & cost)

### T2-1 — Fragile AI JSON parsing, no validation or retry · `OPEN`

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

### T2-2 — Verify the Gemini SDK call · `OPEN`

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

### T2-3 — No rate limiting on AI endpoints · `OPEN`

**Where:** `server.js` — `/api/generate-plan`, `/api/recalibrate-plan`, `/api/generate-recap`

**Symptom:** Any registered account can loop these and bill the Gemini key without limit.
Registration is open with no email verification, so the attacker supply is unbounded.

**Proposed fix:** `express-rate-limit` on the three AI routes, plus a per-user daily generation cap
persisted in the DB. Cheap insurance; low effort.

**Open question:** What's the intended user base? If this stays single-user or friends-only, an
allowlist on registration is simpler and strictly more effective than rate limiting. See `D1`.

---

### T2-4 — Unauthenticated `/api/models` debug route · `OPEN`

**Where:** `server.js:243`

**Symptom:** Public endpoint that proxies the server's Gemini API key to Google and returns the
model list. Leaks only model names today — the key itself stays server-side — but it's an
unauthenticated route with no purpose in a deployed app.

**Proposed fix:** Delete it. If model listing is wanted for debugging, gate it behind
`authenticateToken` and a `NODE_ENV !== 'production'` check.

---

### T2-5 — Catch-all route swallows bad API requests · `OPEN`

**Where:** `server.js:260` — `app.get('*', ...)`

**Symptom:** A typo'd or removed GET endpoint returns `index.html` with status 200. The client
then tries to `JSON.parse` an HTML document, throws, and reports "Network error" — masking the
real problem and making future debugging much harder than it should be.

**Proposed fix:** Mount an `/api/*` handler returning a JSON 404 *above* the SPA catch-all.

---

## Open Issues — Tier 3 (worth doing soon)

### T3-1 — The cycle week never advances · `OPEN`

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

### T3-2 — `journalEntries` never syncs to the server · `OPEN`

**Where:** `index.html` `syncData()` (~L355) sends only `currentPlan` and `workoutJournal`

**Symptom:** Check-in reflections (energy, pains, intentions) live in localStorage forever and are
lost on any new device — even though `/api/generate-plan` explicitly accepts and prompts on them.

**Proposed fix:** Add a `journal_entries` JSONB column to `user_data`, include it in the sync
payload and the GET response. Needs the `ALTER TABLE` path noted in **Constraints**.

---

### T3-3 — Last-write-wins blob sync · `OPEN`

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

## Decisions & open questions

Cross-cutting things to settle before they force rework.

| # | Question | Why it matters | Status |
|---|----------|----------------|--------|
| D1 | Is this single-user, friends-only, or public? | Drives `T2-3`, registration policy, and how much `T3-3` matters | **Unanswered** |
| D2 | Is the checkmark authoritative, or are typed values? | Blocks `T1-2` | ✅ **Decided 2026-09-12** — checkmark only |
| D3 | Is a "cycle" 4 distinct weekly plans, or one plan progressively loaded? | Blocks `T3-1`, shapes schema in `T3-3` | **Unanswered** |
| D4 | Keep plan history, or only ever the current plan? | Schema decision; cheaper to make now than later | **Unanswered** |
| D5 | Does the clone live inside OneDrive or outside it? | Blocks `T1-0` | ✅ **Decided 2026-09-12** — outside |

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
