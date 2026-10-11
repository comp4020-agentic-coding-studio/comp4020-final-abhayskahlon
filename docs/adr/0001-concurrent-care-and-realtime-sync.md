# ADR 0001: Concurrent care actions, rejection, and real-time propagation

**Status:** Accepted — Week 9/10 (crit 9), 2026-10-11.

## Context

COMMONS has no login and no per-user state: every visitor acts on the same
one row in `creature`. The brief for this week asks for exactly one
documented decision about what happens "when several people use it at once,"
covering, in the brief's own words, what reaches other people live versus
what waits for a reload, and what happens when two people change the same
thing at once.

Three things are really one decision here, not three: how a concurrent
write against the shared row is applied, how an action the current state
doesn't allow is handled, and how a successful change reaches every other
open session. They have to agree with each other — a concurrency model that
silently drops or reorders writes would make the real-time feed lie about
what actually happened, and a real-time feed that pushed state the database
hadn't actually committed would do the same from the other direction.

This is also where this project's own definition of quality is most
directly at stake:

> A good shared-care system makes collective responsibility visible without
> turning care into competition. (`README.md`, "What 'good' means here")

Visibility only means something if what's shown is *true* — the actual
sequence of actions that actually happened, attributed to the sessions that
actually performed them, never an artifact of which request happened to
race another one.

## Decision

1. **Applying concurrent writes.** Every action runs inside a single
   `db.transaction(...)` against one `better-sqlite3` connection
   (`src/lib/db.ts`, `performAction()`), with no `await` between reading the
   current row and writing the new one. Node's single-threaded event loop
   plus `better-sqlite3`'s synchronous API mean two requests that arrive "at
   the same time" are never actually interleaved mid-write: they become two
   sequential transactions in arrival order. There is no optimistic
   locking, no version column, and no distributed coordination — concurrency
   is handled by making the critical section impossible to interleave, not
   by detecting and resolving conflicts after the fact.

2. **Rejecting invalid actions.** `applyAction()` (`src/lib/creature.ts`) is
   a pure function: given the current snapshot and an action, it returns
   either a successful transition or a rejection reason. `performAction()`
   checks this *inside* the same transaction, before any write. A rejection
   writes nothing: no stat change, no `care_events` row, no change to
   `last_actor_session_id` — it still returns a `4xx` with the real reason
   string (`src/pages/api/actions.ts`), never a silent no-op and never a
   coerced "closest valid" action. The one narrow exception is
   `resolveAndSync()`'s housekeeping write of an already-expired sleep
   cooldown, which happens regardless of whether the action it's validating
   succeeds — it corrects state that was already stale, not the rejected
   action's own effect.

3. **Reaching other sessions.** `broadcastUpdate()` (`src/lib/sse.ts`) is
   called once per successful transaction, after it commits, to every open
   `/api/events` connection. The payload is a bare `{}` — never a copy of
   the new state. Every receiving client (including the actor's own tab,
   via the same code path) responds by re-fetching `GET /` and swapping in
   the complete `#live-state`. The database is the only thing anyone's view
   is ever built from; SSE only ever says "something changed, go look."

Together: a concurrent write is never lost or duplicated, an invalid one is
never silently absorbed, and nobody's screen can show a state that isn't
really the one SQLite holds.

## Alternatives considered

- **Optimistic concurrency control** (a `version`/`updated_at` column read
  by the client, sent back on the next write, rejected with a conflict if
  it's stale). This is the standard answer once more than one writer can
  touch a row, and it's what most multi-user apps reach for. Rejected here
  because it solves a problem this deployment doesn't have: `fly.toml`
  fixes exactly one machine and one volume, so there is no second process
  that could race the first one at the database level — the single
  synchronous transaction already gives the stronger guarantee (no
  conflicts possible, not just conflicts detected) for free. Optimistic
  locking would add a real cost this app would actually pay — a confusing
  "someone else changed Milo, try again" dead end for a visitor who just
  clicked a button once — for a race condition that can't occur in the
  current deployment shape.

- **Polling instead of SSE** for propagation. Rejected because a polling
  interval tight enough to feel like "about a second" either wastes
  requests or defeats `fly.toml`'s `auto_stop_machines` idling, which is
  most of why running this app costs cents rather than dollars. SSE only
  sends anything when a mutation actually commits.

- **WebSockets** instead of SSE. Rejected because nothing in this app needs
  client→server push outside the ordinary `POST /api/actions` request;
  `EventSource` already gets free browser-native reconnect for the one
  direction (server → other open tabs) this app actually uses, at the cost
  of a second protocol and its own reconnect handling for no gained
  capability.

(These three are not hypothetical for this write-up — PROCESS.md's Decision
4 and Decision 5 already recorded them, independently, before this week.
This ADR is the one decision all three strands are argued together, as one
coherent position, for the crit.)

## Trade-offs

- **Ordering is arrival order, not click order.** Two visitors who click at
  what feels like the same instant are serialized by whichever request's
  transaction the single process reaches first — which depends on network
  and scheduling, not on who clicked first. Nothing in COMMONS promises
  fairness by click time, only that whichever order actually happened is
  the one both the stats and the history consistently reflect.
- **A race can legitimately produce one success and one rejection.** If two
  sessions both attempt `sleep` at once, the transaction that runs second
  sees the first one's committed result and is correctly rejected
  ("already asleep") — not a bug, but a direct, intended consequence of
  serializing through one synchronous handle. `spec/concurrency.test.ts`
  proves the no-lost-update property for four actions that all succeed from
  the seeded state; it deliberately does not include a scenario engineered
  to make one of two concurrent actions fail (see its own comment on why
  `sleep` is excluded, to avoid also permuting activity-state transitions).
  That means this specific "one wins, one is correctly rejected" case is a
  reasoned consequence of the design and the validation rules, not
  something a dedicated test currently exercises end-to-end — a real gap,
  named here rather than implied to be covered.
- **This does not scale past one machine.** The whole guarantee in point 1
  rests on there being exactly one process holding exactly one SQLite
  connection. Adding a second machine (for availability or load) would
  silently reintroduce the race this design currently makes impossible, and
  would need this decision revisited, not just reused.
- **A missed SSE event is only ever a staleness problem, never a
  correctness one.** Because the database is always the source of truth and
  the client always re-fetches on both success and rejection
  (`src/pages/index.astro`'s `refreshLiveState()`), a dropped or delayed SSE
  message can only make a tab's view briefly stale, never wrong once it
  next loads or acts — the cost is paid in latency, not in showing
  something false.

## Evidence

- `spec/concurrency.test.ts` — fires four distinct sessions' actions
  concurrently via `Promise.all` at a dedicated app instance, and checks the
  *final arithmetic* against every valid sequential ordering of those four
  actions (computed with the real `applyAction`), plus exactly one
  `care_events` row per action. This is what backs the "no lost or
  duplicated update" half of point 1.
- `spec/realtime.test.ts` — proves a connected client receives `event:
  update` only after another session's action actually commits, that a
  rejected action produces no event at all, that multiple connected clients
  all receive the same update, and that the event payload itself can never
  carry creature-state fields (`{}` only). This backs point 3.
- `spec/sessions.test.ts` and `spec/activity-resolution.test.ts` — prove a
  rejection never adds to history or changes the recorded last actor, and
  that the rejection reason reported is always the one actually applicable
  (never a stale one left over from a resolved cooldown). This backs point
  2.
- PROCESS.md, Decision 4 and Decision 5 — the prior, independent write-ups
  of the concurrency and real-time choices this ADR brings together;
  Decision 5 additionally records latency verified against the real Fly
  deployment (~624–645ms, two independent sessions), not assumed from
  localhost.
