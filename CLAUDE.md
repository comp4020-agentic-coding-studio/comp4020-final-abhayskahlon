# COMMONS — project rules

A single shared digital creature, cared for collectively by everyone
currently using the room. The central design question — what happens when
responsibility for one persistent being is shared across several people —
and every decision behind the current shape of the app lives in
`PROCESS.md`. Read it before changing the schema, the action rules, or the
real-time mechanism; these rules summarise it for the agent, not replace it.

## The database is the only source of truth

- SQLite (via Drizzle, `src/lib/db.ts`) holds the entire persistent state:
  `creature` (one row), `sessions`, `care_events`.
- No feature may use an in-memory array, a module-level variable, or
  `localStorage` as its primary record. The in-memory SSE client set in
  `src/lib/sse.ts` is the one deliberate exception, and it is never a record
  of truth — it only decides who gets told about a change the database
  already committed. If the process restarts, that set is empty and nothing
  is lost, because nothing it held was ever authoritative.

## Mutations are server-side, transactional, and validated — always

- Every action (`feed`, `play`, `walk`, `clean`, `sleep`) is applied inside a
  single `db.transaction(...)` in `src/lib/creature.ts` / `src/lib/db.ts`,
  with no `await` between reading the current row and writing the new one.
  This is what makes concurrent requests deterministic (see PROCESS.md,
  Decision 4) — don't introduce an `await` inside that critical section
  without re-reading that decision first.
- An action the current state doesn't allow (e.g. `play` with energy below
  the threshold, `sleep` while already asleep) is rejected with a `4xx`
  response and a reason string — never silently clamped into something
  valid, never coerced, never dropped without a response the caller can see.
- All four stats always stay inside `[0, 100]`. `health`/condition is never
  stored or mutated directly — it is computed from the other four on every
  read (see PROCESS.md, Decision 2). Don't add a `health` column or a
  transition rule that writes to it.

## Exactly five actions, exactly four stats

- `feed`, `play`, `walk`, `clean`, `sleep` — no more. Each (other than
  `clean`) both gives and costs something, deliberately, so one visitor's
  action changes what the next visitor should reasonably do. See the table
  in PROCESS.md Decision 3 before changing any effect or threshold.
- `hunger`, `energy`, `happiness`, `cleanliness` — no more. All four run in
  the same direction: **higher is always better**. `hunger` means how fed
  the creature is, not how hungry — the UI labels it "Fullness" for exactly
  this reason; don't flip the convention in one place without flipping it
  everywhere (schema comment, creature.ts, UI copy all assume it).

## Real-time is SSE, and the database stays authoritative through it

- `src/lib/sse.ts` broadcasts to open `/api/events` connections after a
  mutation commits. The broadcast payload is never the only place a piece of
  state lives — a client that reconnects can always re-fetch current state
  from `GET /`, because nothing in the SSE payload isn't already in SQLite.
- Don't add polling or WebSockets alongside this without a new decision
  record explaining why SSE stopped being sufficient (PROCESS.md Decision
  5).

## Session identity is a cookie, not an account

- `src/lib/session.ts` mints a random token and a display label on first
  visit. No password, no login form, no identity that persists across
  browsers. Don't add authentication — it's explicitly out of scope for this
  deliverable (PROCESS.md, "Out of scope").

## Testing

- `spec/invariants.test.ts` and `spec/global-setup.ts`'s core boot-and-poll
  logic are the course's fixed baseline — never edit `spec/invariants.test.ts`
  or `fly.toml`. `spec/global-setup.ts` was extended (not replaced) to spawn
  the built server itself with a throwaway database and shortened
  test-only timings, following the same "local fixture, env-var seam"
  pattern the course's other starter repos use — see the comments in that
  file for the exact seams (`DATABASE_PATH`, `SLEEP_COOLDOWN_MS`) and never
  set them in `fly.toml` or the `Dockerfile`.
- `spec/sessions.test.ts` proves attribution (a successful action is
  recorded against the session that performed it) and that a rejection adds
  nothing to the history. `spec/persistence.test.ts` and
  `spec/realtime.test.ts` each spin up their own app instance rather than
  sharing the one above — both assert on exact state or timing windows that
  another spec file's actions landing on a shared instance made genuinely
  flaky, not just slow, when first written.
- **Known gap:** nothing here fires truly concurrent/overlapping requests
  and checks the resulting arithmetic. The concurrency guarantee (Decision 4
  — one machine, one synchronous `better-sqlite3` handle, no `await` between
  reading and writing) is real and was reasoned through carefully, but it is
  currently backed by that architectural argument and by manual testing
  (sequential actions, a real process restart), not by a dedicated
  concurrent-fire spec test. Don't claim one exists; add it properly if it's
  wanted, rather than writing a test that merely confirms `Promise.all`
  resolves.
- Production real-time behaviour (latency, buffering, reconnect, autostop)
  was verified against the actual Fly deployment, not assumed from
  localhost — see PROCESS.md, Decision 5, "Verified against the real
  deployment."

## Out of scope

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, realtime infrastructure beyond the single SSE endpoint above,
admin dashboards, machine learning, leaderboards, achievements, shops,
inventories, multiple creatures, or AI. See PROCESS.md for the one idea
(a non-competitive "neglect" callout) that was considered and deliberately
deferred rather than rejected outright.
