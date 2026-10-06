# COMMONS — project rules

A single shared digital creature, Milo, cared for collectively by everyone
currently using the room. The central design question — what happens when
responsibility for one persistent being is shared across several people —
and every decision behind the current shape of the app lives in
`PROCESS.md`, including three real bugs found via human playtesting and how
each was actually diagnosed and fixed ("Incidents found via human
playtesting"). Read PROCESS.md before changing the schema, the action
rules, or the real-time mechanism; these rules summarise it for the agent,
not replace it.

The name "Milo" is a fixed literal (`src/pages/index.astro`, in both the
frontmatter and the client script) — not a naming feature, nowhere settable
by a visitor. Don't add a naming system; don't let the two literals drift
apart if one of them ever needs editing.

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
  A rejection never creates a `care_events` row and never changes stats or
  `last_actor_session_id`. The one narrow exception, added after Incident 2
  in PROCESS.md: `resolveAndSync()` may still write `activity`/
  `activity_until` during a rejected action's validation, but only to
  correct a sleep cooldown that has already, unconditionally expired —
  that's housekeeping matching what the very next read would do regardless,
  never the rejected action's own effect.
- The client never invents, guesses, or reconstructs a rejection reason:
  `readRejectionReason()` in `src/pages/index.astro` only ever shows
  exactly what `/api/actions` sent, and refuses to render a response whose
  content-type is HTML (see PROCESS.md, Incident 1) rather than ever
  display raw markup as if it were a reason.
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
  mutation commits — on success only; a rejection never reaches
  `broadcastUpdate()`. The broadcast payload is a bare signal (`{}`), never
  a copy of state — a client that reconnects, or that gets this signal,
  always re-fetches current state from `GET /`, because nothing in the SSE
  payload isn't already in SQLite.
- `refreshLiveState()` in `src/pages/index.astro` is the one place that
  re-fetch happens, and it always swaps the *complete* `#live-state` (stats,
  condition, activity, last action, and history together) — never a
  subset. It runs after an SSE `update` event for every other open tab,
  and — since Incident 1 in PROCESS.md — after the actor's own action too,
  on **both** success and rejection: a rejection can mean this tab's own
  view was stale (it missed an event), and refreshing is what makes that
  visible instead of leaving a stale badge next to a reason that
  contradicts it. Don't special-case the actor's own tab back to a
  different mechanism (a full `location.reload()`, a partial DOM patch) —
  that divergence between "my own action" and "someone else's action,
  seen live" is exactly what caused Incident 1.
- Don't add polling or WebSockets alongside this without a new decision
  record explaining why SSE stopped being sufficient (PROCESS.md Decision
  5).

## Never read `form.action` — use `getAttribute("action")`

- Every action form carries a hidden input `name="action"`. Per the
  HTML/DOM named-property algorithm, that control **shadows**
  `HTMLFormElement`'s own built-in `action` property in real browsers:
  `form.action` resolves to the input element itself, not the URL string,
  and `fetch(form.action, …)` silently stringifies it to
  `"[object HTMLInputElement]"` — a real production bug (PROCESS.md,
  Incident 3), found only by a human clicking a real button, never by any
  scripted test, because every script calls `fetch()` with a hand-built URL
  string and never touches a real DOM form.
- The fix, `form.getAttribute("action")`, is what's in the code now and
  must stay. Don't revert to `form.action`. Don't rename the `"action"`
  input to dodge this either — the server's whole validated vocabulary
  (`src/lib/creature.ts`'s `ACTIONS`, `src/pages/api/actions.ts`'s
  `form.get("action")`) is built around that field name and is correct; the
  bug was purely in how the client located the URL.
- `spec/action-form-url.test.ts` guards this with a static source check
  (`fetch(form.action` must never reappear) — jsdom itself doesn't
  reproduce the shadowing, so that test can't exercise the original
  failure, only the fix and the regression guard. Don't treat that test
  passing as proof the shadowing can't recur in a real browser; it proves
  the known-bad pattern hasn't crept back into the source.

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
- `spec/concurrency.test.ts` closes the gap this section used to note:
  it fires genuinely concurrent requests (several distinct sessions, one
  action each, via `Promise.all`, no shared cookie jar) at this test's own
  app instance, then checks the *final state's arithmetic* against every
  valid sequential ordering of those actions — computed with the real
  `applyAction` function, not a reimplementation of it — rather than merely
  confirming `Promise.all` resolved. Keep that standard if this test is ever
  touched: a change that makes it pass by checking less than that isn't a
  fix, it's a regression.
- Production real-time behaviour (latency, buffering, reconnect, autostop)
  was verified against the actual Fly deployment, not assumed from
  localhost — see PROCESS.md, Decision 5, "Verified against the real
  deployment."
- `spec/activity-resolution.test.ts` (its own instance, `SLEEP_COOLDOWN_MS`
  overridden short) proves the consistency property behind Incident 2:
  once a sleep cooldown has genuinely passed, the very next action
  succeeds with no GET in between, and a later rejection names the
  actually-applicable rule (e.g. "too hungry to sleep"), never a
  stale "already asleep".
- `spec/action-form-url.test.ts` guards Incident 3 (see "Never read
  `form.action`" above) — the one spec file here that constructs a real
  DOM form element rather than only calling `fetch()` with a hand-built
  URL string, and the only one that can catch this class of bug at all.
- Every spec file above was written to protect a real, previously-reported
  or previously-reasoned-about failure — not added speculatively. Don't add
  a new one without a specific invariant it protects that nothing else
  here already covers.

## Out of scope

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, realtime infrastructure beyond the single SSE endpoint above,
admin dashboards, machine learning, leaderboards, achievements, shops,
inventories, multiple creatures, or AI. See PROCESS.md for the one idea
(a non-competitive "neglect" callout) that was considered and deliberately
deferred rather than rejected outright.
