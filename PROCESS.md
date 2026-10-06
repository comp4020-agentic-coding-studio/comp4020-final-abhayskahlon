# Process overview

How this app got from the Crit 8 brief to its harness, agentic workflow and
stack — as a sequence of decision records, each written before (or right at)
the commit that acted on it. Commit links are added as the work lands, so a
decision below cites the commit that carried it out once that commit exists.

## Decision 1 — concept: COMMONS

**Decision.** Build a single shared digital creature that an entire room of
visitors cares for collectively — one persistent being, not one per user. The
design question driving it: *what happens when responsibility for one
persistent digital being is shared across several people?* First definition
of good, to be refined in README.md: *a good shared-care system makes
collective responsibility visible without turning care into competition.*

**Why.** The brief asks for a stranger to visit, do the core thing, and find
their trace still there later — a single shared creature makes that trace
*other people's* traces, not just your own, which is what makes the "shared"
half of the brief's multi-user requirement do real design work instead of
being an incidental technical box to tick.

**Approved.** 2026-10-04, after a written design proposal covering schema,
transitions, concurrency, identity, realtime, persistence, UI, tests, and
risks. The approval carried these corrections to the original proposal,
recorded as their own decisions below: health derived not stored (Decision
2), exactly five actions with real trade-offs (Decision 3), no neglect
callout in v1 (Decision 3), and a requirement to make shared custody visually
obvious without a leaderboard (Decision 6).

## Decision 2 — stats: four stored, one derived

**Decision.** Store exactly four needs — `hunger`, `energy`, `happiness`,
`cleanliness` — each 0–100. Do **not** store `health`/condition as its own
field or give it independent mechanics. Compute it on every read as a simple
function of the other four.

**Why.** A stored health field needs its own transition rules to stay
consistent with the other four, which is exactly the kind of mechanic the
brief's "keep it small" framing argues against, and it opens a whole class of
impossible states (health high while every other need is at zero) that a
derived value can't ever reach, because it's never written — only read.

**Convention (easy to get backwards, so stated once, here):** all four
stored stats run in the same direction — **higher is always better** (100 =
fully satisfied). `hunger` therefore means *how fed* the creature is, not how
hungry — the UI labels it "Fullness" to avoid the ordinary Tamagotchi
reading where a full hunger bar means starving.

## Decision 3 — five actions, each with a real trade-off

**Decision.** Exactly `feed`, `play`, `walk`, `clean`, `sleep`. Every action
(other than `clean`) costs something it also gives, so one person's choice
changes what the next person should reasonably do:

| action | gives | costs | server rejects when |
|---|---|---|---|
| feed | hunger +30, happiness +5 | cleanliness −5 | never |
| play | happiness +20 | energy −15, hunger −10, cleanliness −10 | energy < 15 ("too tired to play"), or asleep |
| walk | happiness +10 | energy −10, hunger −5, cleanliness −15 | energy < 10 ("too tired to walk"), or asleep |
| clean | cleanliness → 100, happiness +5 | — | asleep |
| sleep | energy → 100 | holds the creature unavailable (feed/play/walk rejected) for a short fixed cooldown | hunger < 20 ("too hungry to sleep"), or already asleep |

Sleep is deliberately the sharpest trade-off: one visitor can decide the
creature sleeps, which immediately benefits it but makes it briefly
unavailable to everyone else in the room — a direct, small, testable version
of "shared responsibility." No explicit "wake" action: the cooldown expires
on its own, checked lazily whenever the next action (or read) happens, so
there's no cron and no background process.

**Deferred, explicitly not built in v1:** the "what's been neglected longest"
callout from the original proposal. It's a legitimate idea for making
collective neglect visible without a leaderboard, but it's additional
mechanism the brief doesn't require yet — revisit only with time to spare,
and only non-competitively (no per-user attribution of blame).

## Decision 4 — concurrency: one machine, one synchronous handle

**Decision.** No optimistic locking, no version column, no distributed
coordination. Every action runs inside one `db.transaction(...)` against a
single `better-sqlite3` connection, with no `await` between reading the
current state and writing the new one.

**Why this is sufficient, and why it's a trade-off, not a shortcut.**
`fly.toml` (fixed by the course) runs exactly one machine with one volume —
there is no second process and no second machine that could race this one.
Node's event loop is single-threaded, and `better-sqlite3`'s API is
synchronous, so a handler with no `await` in its critical section cannot be
interleaved by another request arriving concurrently: two simultaneous
`feed` calls become two sequential transactions in arrival order, not two
racing writes. This is deliberately **not** a generally-scalable answer —
it would not hold across multiple machines or a replicated database, and if
this app ever needed more than one machine, this decision would need to be
revisited and rewritten as a new record, not quietly assumed to still hold.
It is, however, exactly matched to the one-machine/one-volume shape the
course's Fly setup fixes for this assignment, so building anything more
elaborate (row versioning, a queue, a lock service) would be unneeded
distributed-systems infrastructure for a single-process deployment.

`spec/concurrency.test.ts` proves this holds: it fires several actions at
once and checks the *final state's arithmetic* is consistent with every
action having been applied exactly once — not just that `Promise.all`
resolved.

## Decision 5 — real-time: Server-Sent Events

**Decision.** One `GET /api/events` endpoint per connected client, held open,
broadcast to from an in-memory set whenever a mutation commits. The database
remains authoritative throughout — SSE never carries state the database
doesn't already hold, and a client that misses an event can always re-fetch
current state from `GET /`.

**Why SSE over the alternatives, for this app specifically:**

- **vs. polling** — polling tight enough to feel like "within about a
  second" either wastes requests or keeps the Fly machine from ever being
  allowed to idle (`fly.toml`'s `auto_stop_machines` is most of why this app
  costs cents, not dollars). SSE only sends a message when something
  actually changed.
- **vs. WebSockets** — nothing in this app needs client→server push outside
  the ordinary `POST /api/actions` request. A second protocol, with its own
  reconnect handling, buys no capability this app uses. `EventSource` gets
  free auto-reconnect from the browser for the one direction this app
  actually needs (server → other open tabs).

This is sound specifically *because* there is exactly one machine (Decision
4) — an in-memory broadcast set would not reach clients connected to a
different machine, which is a real limitation this app accepts rather than
engineers around, for the same one-machine-is-the-fixed-shape reason as
Decision 4.

**Verified against the real deployment on 2026-10-06**, after the first
deploy to `https://comp4020-final-abhayskahlon.fly.dev/` — not assumed from
localhost behaviour:

- **Latency.** Two independent HTTP sessions (separate cookie jars, separate
  `/api/events` connections, no shared state) against the live HTTPS URL:
  an action in one landed in both streams in ~624ms and ~645ms — comfortably
  under the brief's "about a second," over the real network.
- **No proxy buffering observed.** The initial `retry:`/`: connected` write
  and every subsequent 15s heartbeat arrived on schedule over a ~50s idle
  window, rather than arriving all at once when some buffer eventually
  flushed. `X-Accel-Buffering: no` appears to be respected (or at least not
  contradicted) by Fly's proxy for this response.
- **Reconnect.** Closing a connection and opening a fresh one re-establishes
  cleanly and immediately resumes receiving live updates — nothing
  session-specific needs to survive a drop, by design (Decision 5 above).
- **Autostop.** Confirmed both halves: an open `/api/events` connection kept
  the machine `started` for a full 5-minute observation window with no other
  traffic; with the connection closed, the machine did autostop (`started` →
  `stopped`) within about a minute of being idle, and a subsequent plain
  request cold-started it correctly (200 OK in ~2.5s). A second attempt to
  observe the idle-to-stop transition took longer than 4 minutes without
  stopping — Fly-side timing variability, not something traced to the app.
- **Persistence.** Survived an actual `flyctl machine restart`: identical
  state and timestamp read back once the machine came back up, confirming
  SQLite on the mounted volume — not the Node process's memory — is what
  survived.

**Known limitation, not yet tested:** the specific case of an SSE connection
being the *very first* request during a cold boot (rather than a connection
opened against an already-warm machine, or a plain request triggering the
cold start). Everything else — cold starts generally working, reconnects
generally working — is strong indirect evidence this would be fine, but
that exact combination wasn't isolated and confirmed.

## Decision 6 — shared custody must be visible, never a leaderboard

**Decision.** The UI always shows: the single shared creature's current
needs, what the latest action was, which session performed it, and when. A
short chronological history of recent actions (capped, not unbounded) is
shown so multiple different visitors' actions are visible together over
time. No per-user scores, rankings, or any representation that invites
comparing visitors against each other.

**Why.** This is the main defence against the concept reading as "a
Tamagotchi clone with a chat log bolted on" — the single creature plus a
visible, un-ranked history of who did what is what makes shared
responsibility legible, which is the actual design question this prototype
is testing.

## Decision 7 — session identity: cookie, no login

**Decision.** First request with no session cookie gets a random token
(`crypto.randomUUID()`), an httpOnly cookie, and a `sessions` row with a
generated display label (e.g. "Calm Otter"). No password, no account, no
persistence of identity across browsers or devices — matches the brief's "no
authentication required" exactly. Two tabs in the same browser are
deliberately one visitor; a different browser or incognito window is a new
one.

## Decision 8 — history is capped, not unbounded

**Decision.** `care_events` keeps the most recent ~50 rows; older rows are
pruned on insert. "A small persistent care history" is read here as a
deliberate bound, stated once, not an accidental drop of old data discovered
later.

## Out of scope for this deliverable (unchanged from the course's own list)

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, admin dashboards, machine learning — and, specific to this
concept, no leaderboards, achievements, shops, inventories, multiple
creatures, or AI. The neglect callout (Decision 3) is the one idea considered
and explicitly deferred rather than rejected outright.

## Commit log (evidence)

Each entry links the commit that carried out the decision it's filed under.

- Decision 1 (concept) and the harness rules summarising every decision
  below: [`92b29b2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/92b29b2991409cd7b78a2624f6d204f2e4c31911)
- Stack set up (Astro + Node adapter + Drizzle/SQLite, re-derived rather than
  copied from crit 7; `spec/global-setup.ts` extended to spawn the built
  server locally while still deferring to CI's own instance when `APP_URL`
  is set): [`e155a30`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/e155a305defcac42ec076de170539c39a75f37f1)
- Decisions 2 and 4 (derived health; the one-machine/synchronous-transaction
  concurrency mechanism) landed as the first vertical slice — schema, seed,
  the `feed` action, and a manually-verified process restart proving SQLite,
  not memory, holds the state: [`c8f9c94`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/c8f9c94d99cc867817cc750f95da2539e04268f9)
- Decision 3 (the five actions and their trade-off table, including sleep's
  cooldown as the sharpest one): [`940a8e7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/940a8e704d0cc8b124340b3290c12da9f5cf37b3)
- Decisions 6, 7 and 8 (visible, unranked shared history; cookie session
  identity; the 50-row cap) together with the attribution/history/session
  tests: [`b93ef05`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/b93ef0572eac09728f6dd340a142dbbd9581e2f9)
- Decision 5 (SSE, broadcast only on a committed mutation, the event as a
  bare signal never a copy of state) and its tests, including the one that
  proves the payload itself carries no state fields: [`773da57`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/773da579801c70dcc9d607582d6af7b71d8ab030)
  — that commit also fixed a pre-existing flaky test (session display
  labels can legitimately coincide; the attribution test wrongly asserted
  they couldn't) found while re-running the suite for this milestone.
