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

**Updated by Decision 13 (crit 10).** "One persistent being, not one per
user" is still true *within* a room — what changed is that "the room" is
now an explicit, chosen scope (one creature per room, joined or hosted by
code) rather than an implicit one (one creature, period). See Decision 13
for the full accounting of what stayed true and what changed.

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

## Decision 9 — a single fixed name, Milo

**Decision.** The creature is named "Milo" — one literal string, in the
server-rendered page and in the client script, nowhere settable by a
visitor. Replaces every generic "the creature" in the rendered UI and
history text ("fed Milo", not "fed the creature"); adds minimal, literal
activity feedback ("Milo is eating" / "playing" / "out for a walk" /
"being cleaned" / "sleeping — Ns") computed entirely from fields the server
already sends (`state.activity`, `state.lastAction`) — no new state, no
second source of truth.

**Why.** Explicitly requested as its own small UI-only correction, landed
after the core mechanics (Decisions 1–8) were already built and tested, not
as a new mechanic: a fixed name and a present-tense "what's happening"
phrase make the shared creature feel like one specific, continuous thing
worth caring about, without adding any naming system, character creation,
or new server-side concept — see commit `a19b9a3`.

## Decision 10 — Milo's age reuses an existing field, not a new one

**Decision.** Milo's age is `MIN(sessions.createdAt)` — the earliest
session this room has ever seen — not a new `created_at` column on
`creature`.

**Why.** `creature` has no stable creation timestamp: `updated_at` is
overwritten on every mutation (Decision 4's own transaction touches it),
so it can't answer "how old is Milo." `sessions.created_at`, by contrast,
is written once at insert and never touched again (only `last_seen_at`
is), and by the time anything on the page can even ask for Milo's age,
`getOrCreateSession()` has already run for whoever's looking — so the
query is never empty in practice. Reusing it costs nothing: no migration,
no new column, no second timestamp to keep in sync with reality. The
trade-off, stated plainly: this is "how long this shared space has been
visited," not literally "how long the `creature` row has existed" — the
gap between those two moments is however long the server sat idle before
its first visitor, which is the cost of not adding a column for this.

**Superseded by Decision 13.** Rooms now have their own `rooms.createdAt`,
written once at hosting and never touched again — the exact stable-
timestamp column this decision originally argued against adding, except
now it's genuinely needed: `MIN(sessions.createdAt)` was a deployment-wide
query with no way to scope it to one room, so the workaround this decision
describes no longer applies. Milo's age is now read directly off the room
it belongs to. Left here, not deleted, because the reasoning above is still
correct history for why that workaround existed in the first place.

## Decision 11 — wardrobe is cosmetic, shared state, not an inventory

**Decision.** Two columns on the one `creature` row — `hat`, `neckwear` —
each a small fixed, authored vocabulary, each independently nullable
("nothing in this slot" is always a valid, un-rejectable choice). No
acquisition, no scarcity, no per-session ownership, nothing to unlock or
manage.

**Why this isn't the "shops, inventories" this deliverable rules out.**
The out-of-scope list below names "shops, inventories" because those imply
something to acquire, something scarce, something owned — exactly what
would turn shared care into a collection to manage or compete over. A
wardrobe pick here is the same shape as `activity` being `idle` or
`sleeping`: one more fact about the one shared creature, changeable by
anyone, visible to everyone, costing nothing and limiting nothing. It's
recorded in `care_events` (`action: "wardrobe"`) for the same reason every
other change is — visible, attributed, chronological (Decision 6) — not
because it's a sixth care action.

## Decision 12 — adventure: one outcome, deterministic, not a sixth action

**Decision.** One adventure, not several; no dice roll on whether it
succeeds or what it does. It follows the exact rejection rule every
non-`clean`/`sleep` action already follows (not while asleep) and costs
`energy −10, cleanliness −30`, giving `happiness +15` — the largest
cleanliness cost of anything in the game, on purpose.

**Why.** The brief explicitly rules out random failures; building any
chance of "the adventure goes wrong" would be exactly that, dressed up as
flavour. Determinism was chosen over variety here specifically to avoid
that risk. The oversized cleanliness cost is the entire mechanism for
"visually indicates a Clean would help": it's a bigger pull on the exact
same stat Decision 3's `applyAction` already uses, read by the exact same
stat-driven expression Milo already has — not a second visual system
invented for this one activity. Kept out of `ACTIONS`/`applyAction`
deliberately (its own `applyAdventure`, its own route,
`src/pages/api/adventure.ts`) so Decision 3's "exactly five actions" stays
true in code, not just in spirit.

## Decision 13 — dedicated rooms: one creature per room, not per deployment

**Decision.** COMMONS' "one shared creature" promise now applies per
**room**, not per deployment. A visitor enters a display name and either
joins an existing room by a 6-character code or hosts a brand-new one;
everyone who joins or hosts the same room shares that room's own creature,
history, and real-time broadcast — isolated from every other room. A
session belongs to whichever room it most recently joined or hosted
(joining/hosting always overwrites; there's no separate "leave").

A room's host is recorded and shown ("Hosted by X") but has **no powers an
ordinary member lacks** — attribution only, the same pattern
`lastActorSessionId` already uses elsewhere. The room a mutating request
acts on is always derived from the trusted, httpOnly session cookie, never
from a client-supplied field — there is no `roomId` input anywhere for a
crafted request to redirect at another room. Full design, alternatives, and
security reasoning: `docs/adr/0002-multi-room-identity-and-access-control.md`.

**Why this is a pivot, not a quiet contradiction.** Decision 1 originally
framed COMMONS as "one persistent being, not one per user," and the
out-of-scope list below used to name "multiple creatures" outright. Both
were written when "the room" meant the entire deployment. What those rules
were actually protecting — one shared creature per group, visible unranked
collective care, no per-user pet, no leaderboard — is unchanged and now
holds separately *inside* each room; what changed is that the group itself
became an explicit, chosen scope instead of a fixed, implicit one. This is
recorded here and in the ADR specifically so it reads as a deliberate
decision, not as code quietly drifting away from its own rules.

**The legacy single creature is not reset.** The schema migration
(`drizzle/0003_*.sql`) backfills any pre-existing creature, sessions, and
care history into one fixed room, `id = "COMMONS"` — production's existing
Milo and history survive with no visitor-facing disruption. On a fresh
database, every backfill statement matches zero rows: a correct no-op, not
a forced default room.

Two details here were wrong in an earlier draft of this migration, caught
and fixed before deploying: `host_session_id` is left `NULL`, not set to
whoever most recently acted — the most recent actor isn't who created the
room (which predates rooms entirely, so literally nobody hosted it), and
attributing it to them would have shown a real visitor as "Hosted by X" for
something they never did. `created_at` is backfilled from the earliest
session this app has ever recorded (`MIN(sessions.created_at)`), not
`creature.updated_at` — the latter is overwritten by every mutation
(Decision 4's own transactions touch it), so reading it at migration time
would have silently reset Milo's displayed age to "new" instead of
preserving its real history. This mirrors exactly what `getMiloAge()` used
to compute before Decision 13 (see Decision 10) — the oldest evidence this
app has of when the shared space was first visited.

**Server-side logging, added alongside this.** `src/lib/log.ts` writes one
structured line to stdout per room host/join/rejected-join and per care
action's outcome (success *and* rejection) — the concrete gap this crit's
spec names directly: a durable, server-side record of who did what. A
rejection is still never written to `care_events` (unchanged from the rule
above); this log is the one place a rejection's attribution is recorded at
all. Each line carries `actor` — a stable, one-way SHA-256 digest of the
session id, never the raw id itself — rather than the session's actual
bearer credential; see the dedicated note below for why, and
`spec/logging.test.ts` for the regression coverage.

**Session credential never appears in logs.** `commons_session`'s cookie
value IS the session's entire bearer credential (Decision 7 — no password
layer at all): whoever holds it can act as that session, in whatever room
it currently belongs to. An earlier draft of `log.ts` wrote that raw value
straight into every log line — found and fixed during ship-readiness
review, before this ever shipped, because anyone able to read these logs
(course staff via `flyctl logs`, or anyone else with log/Fly access) could
have lifted it and used it to impersonate that session. The fix:
`actorTag()` hashes the session id (SHA-256, truncated to 10 hex
characters) before it's ever logged — the SAME session always produces the
SAME tag (attribution is preserved; a tutor can still tell "these five
lines are the same visitor"), but the tag can never be reversed back into
the credential that would let someone act as them.
`spec/logging.test.ts` proves this directly against a server instance's
REAL captured stdout, not just by reading `log.ts`'s source: a successful
action, a rejected action, hosting, and joining all log an attributable,
stable tag; the same session produces the same tag across multiple events;
and the raw session id, confirmed minted for several real sessions in the
test, never appears anywhere in the captured output.

**What's actually verified about log retention, and what isn't.**
"Outlives the crit" was initially asserted here without checking what Fly
actually guarantees — corrected during ship-readiness review. What's
confirmed, from Fly's own documentation
(`docs.fly.io/monitoring/logs-api-options`,
`docs.fly.io/monitoring/search-logs`) and direct inspection of this app's
deployment:

- Plain `flyctl logs --no-tail` (what this project's own `spec/README.md`
  and the crit brief point to) returns only an in-memory buffer — observed
  directly against the live deployment as exactly 100 lines, spanning
  minutes, not days, even though the underlying machine had been running
  for over a week. This is NOT a multi-day retention mechanism, regardless
  of what the longer figure below applies to.
- Fly's documentation describes a separate mechanism — a Grafana-based
  "Search logs" feature (beta, backed by VictoriaLogs) at
  `fly-metrics.net` — stating "we currently retain logs for 7 days." This
  page states no paid-plan requirement and no additional setup beyond
  using the dashboard link. It requires an interactive, SSO-authenticated
  browser session to use; it could not be reached or confirmed working for
  this specific org/app from this review (an unauthenticated or
  token-based request to it redirects to a login page, and Fly's HTTP
  Logs API — the mechanism the 7-day figure is actually describing —
  returned 401 against this app with the project's own Fly API token, which
  is consistent with that API being explicitly unofficial and unstable per
  Fly's own docs, not necessarily evidence against the 7-day figure itself).
  Community reports (Fly's own forum) independently corroborate "our
  retention for app logs is 7d" as the current stated standard, with older
  threads citing shorter windows (48h) from earlier periods — this history
  is the reason the figure is treated as "documented, not independently
  re-verified for this org" rather than settled fact.
- No plan-tier distinction for this retention window is stated anywhere
  found. One data point from this org's own Fly account metadata showed
  `PaidPlan: false` on a nested record, which is suggestive but not
  conclusive (that field was read from a sub-object, not a confirmed
  top-level billing record).

**Conclusion, stated plainly: retention is not independently confirmed for
this org, only documented by Fly as ~7 days via a feature this review could
not directly exercise.** The final project's assessment window extends
roughly three weeks past this crit (2026-11-09) — well beyond even the
documented 7-day figure. **stdout logs alone should not be relied on as
the durable record for anything beyond the crit week itself.** `care_events`
in SQLite remains the actually-durable, queryable record of every
*successful* action for as long as the app's volume exists. Given that
gap, a small, bounded `log_events` table was built as the durable fallback
— described next.

**The `log_events` table (built, not just proposed).** A second,
server-only, bounded record of every care action and room event, success
and rejection alike — the actual durable fallback for whatever Fly's log
retention turns out to be, since that couldn't be independently confirmed
(above). `src/lib/db.ts`'s `safeWriteLogEvent()` writes one row per event,
immediately after the event's own outcome is already decided; a read-only
route, `src/pages/api/rooms/events.ts`, lets the current session read
*its own room's* rows back (JSON, not a rendered page) — the same
server-derived-room-never-client-supplied rule every other route already
follows (docs/adr/0002): there is no room-id parameter this route accepts,
so a session can only ever read the room its own trusted cookie names.

Design choices, each made deliberately:

- **Durability despite a rolled-back transaction.** A rejected action's
  own mutation transaction never commits (by design — CLAUDE.md). Its log
  row still must. `safeWriteLogEvent()` is called AFTER the mutation's
  `db.transaction(...)` has already returned — committed or rolled back —
  as a plain, unconditional statement outside that transaction, with the
  SAME final `outcome`/`reason` the stdout log already received. This is
  what makes a rejection durably recorded despite its own mutation never
  landing: the log write was never nested inside the thing that rolled
  back in the first place.
- **No raw credential, ever.** `log_events.actor` reuses `src/lib/log.ts`'s
  `actorTag()` — the exact same one-way SHA-256 digest the stdout channel
  already uses (exported from `log.ts` specifically so there is exactly
  one definition of "how a session id becomes a loggable actor," never two
  that could drift). The raw session id is never passed anywhere near this
  table.
- **Explicit failure handling.** `writeLogEvent()`'s own insert can itself
  fail (disk, corruption, anything); `safeWriteLogEvent()` wraps it in a
  try/catch and logs the failure to stderr rather than letting it
  propagate. Every call site invokes this AFTER the action's real,
  already-independently-decided result is computed — a logging failure can
  therefore only ever cost a missing audit row, never flip a rejection
  into an apparent success or vice versa. `spec/log-events.test.ts` proves
  this against a REAL server instance by dropping `log_events` from a
  separate connection to the same database file mid-test and confirming
  both a successful and a rejected action still behave correctly, and the
  server stays up.
- **Bounded, per room, same pattern as `care_events`.** `LOG_EVENTS_LIMIT`
  (200, in `src/lib/db.ts`) caps each room's own rows independently,
  pruned on every durable write — the same "capped, not unlimited" shape
  Decision 8 already established for `care_events`, sized larger because
  this table is the only durable record of rejections too (which
  `care_events` never stores). A durable log that could grow forever would
  eventually threaten the one-volume deployment's disk, defeating its own
  purpose.
- **Room isolation, enforced the same way as everywhere else.** The read
  route derives the room from the trusted session cookie, never a request
  parameter — the exact mechanism docs/adr/0002 already established for
  every mutating route, extended to this one read route.
- **No external service, no new credential.** Everything here is SQLite,
  on the same volume, through the same `drizzle` connection every other
  table already uses.

A real migration bug was found and fixed while building this.
`spec/room-migration-backfill.test.ts`'s own simulation filtered "pre-rooms
migrations" by *name* (excluding the rooms migration's tag) rather than by
*position* — harmless until a migration was added AFTER rooms (this one):
drizzle-kit's migrator tracks "already applied" against the single most
recent migration's timestamp, not which specific migrations ran, so
leaving a later-timestamped migration in the "pre-rooms" set pushed that
watermark past the rooms migration's own timestamp and caused the real
migrator to skip the rooms migration entirely on the subsequent full pass
— silently leaving the `rooms` table missing. Caught only because the test
actually ran the full real migration set afterward and asserted on its
result, not by reading the migration SQL and reasoning about it. Fixed by
filtering on the journal's timestamp ordering relative to the rooms
migration, not its name.

**Why not rely on `creature.id` reuse or a single global row with a
"current room" flag.** A room needs its own independent stats, activity
cooldown, wardrobe, and capped history — trying to multiplex all of that
through one row (or swapping which row is "active") would mean every
room's state fighting over the same cells, defeating isolation entirely.
One `creature` row per room, with a unique `roomId`, is the only shape that
actually isolates anything.

**Follow-up (post-ship): "COMMONS loads directly, no entry page" was
investigated and found to be sticky-room behaviour working as designed, not
a routing defect.** A report that the production URL opened straight into
the legacy `COMMONS` room, skipping the entry screen, was checked directly
against the live deployment rather than assumed: a genuinely fresh session
(no prior `commons_session` cookie — confirmed with a brand-new cookie jar
and separately in production) correctly rendered the entry page every time.
What actually happened was a browser that had already joined or hosted a
room earlier returning to that room on reload — exactly `getSessionRoom()`
reading `session.roomId` off the trusted cookie, and exactly what
`spec/rooms.test.ts` ("keeps a returning session in its room across a
reload, with no new session cookie") and this decision's point 5 (joining
or hosting always overwrites, sticky until `/?switch=1`) already describe
as deliberate. No change was made to routing, session handling, room
isolation, or the sticky-room behaviour itself — confirming this cost one
false-alarm investigation, not a code change, so it's recorded here rather
than as a new decision.

What *did* change: a visual-only pass on the entry page itself, since on
inspection its copy and layout read more like a generic form than the rest
of this app's deliberately warm, playful visual language (Decision 6's
"shared custody must be visible" styling). The heading now reads "Welcome
to COMMONS" and the intro names the shared-care concept directly (one Milo,
not a separate pet each); "Join a room" and "Host a new room" are now two
visually distinct cards (`.entry-card`, sharing `--color-surface-alt`/
`--color-border`/`--radius-lg` with every other panel on this page) with an
"or" divider between them, instead of one form with a thin rule. No new
colours, fonts, or component system — every token reused is one already
defined in `src/styles.css` for the in-room view. Verified by rendering the
actual page with a headless browser (not just reading the CSS): desktop and
mobile layouts, the room-join rejection's error state, and keyboard focus
all checked directly, and the in-room view (Milo, stats, actions) confirmed
pixel-identical before and after, since none of its selectors were touched.

**Second follow-up: the sticky-room default above was then deliberately
reversed, on explicit instruction, after the person using this app
confirmed they wanted the entry page every time — not just for a genuinely
fresh visitor.** The investigation above stands as written: sticky-room-by-
default was a real, working, deliberate design, not a bug. What changed is
the design itself, by a conscious choice to trade a small amount of
returning-visitor convenience for always making the room choice explicit.

**The mechanism.** `src/pages/index.astro`'s `showEntry` now reads:
`!room || !Astro.url.searchParams.has("enter") || Astro.url.searchParams.has("switch")`
— a bare `GET /` shows the entry page unconditionally, even for a session
whose cookie already names a room. `?enter=1` is the one way to reach the
room view directly, and every internal link that means "go to my room" was
updated to use it explicitly: the five mutating routes' redirects
(`actions.ts`, `wardrobe.ts`, `adventure.ts`, `rooms/host.ts`,
`rooms/join.ts`, all `redirect("/?enter=1", 303)` instead of `redirect("/",
303)`), the client script's own post-host/join `location.href`, and
`refreshLiveState()`'s re-fetch (which only ever runs from a page that
already rendered `#live-state`, so it always needs the room view, never the
entry page). `?switch=1` still exists, doing exactly what `enter`'s absence
already does, kept only so the existing "Switch room" link and any
bookmarks of it keep working.

A new affordance, `.entry-returning` (shown only when `room !== null`),
replaces the silent behaviour the old default provided: "You're still in
room X — continue to your room," linking to `/?enter=1`. This is what makes
"explicitly choose to re-enter" an actual, discoverable UI action rather
than a URL parameter nobody would know to type.

**What this does and doesn't change.** Nothing about session identity, room
membership, room isolation, or the durable logs — `session.roomId` is never
read, written, or cleared anywhere in this change; a session that already
belongs to a room still belongs to it, and `?enter=1` proves that by
resuming it with no new cookie and no re-hosting or re-joining required.
Every mutating route still derives its room exclusively from the trusted
session cookie (docs/adr/0002, completely untouched) — this is a navigation
default, not an access-control change, and the set of things a visitor can
do was never gated by which page greeted a bare `GET /` in the first place.
The cost is purely usability: a returning visitor now sees one extra screen
before reaching Milo on every fresh page load, by design.

**Tests.** `spec/rooms.test.ts` gained a dedicated describe block ("entry
page is the default for a bare GET /, for every visitor") proving: a fresh,
cookie-less visitor sees the entry page; a returning visitor with an
existing room ALSO sees the entry page on a bare `GET /` (not their room
directly); that same session's cookie is never replaced and can still
explicitly resume its room via `?enter=1` with no re-hosting or re-joining;
a mutating action's own server redirect (`Location` header, not just a
subsequent fetch) targets `/?enter=1` and lands back in the room, not the
entry page; and hosting/joining both still redirect straight into the room.
The existing "keeps a returning session in its room across a reload" test
was rewritten to prove the same underlying fact (no new cookie, membership
intact) against the new behaviour, rather than deleted. Every other spec
file's `loadHome()`-shaped helper (`adventure`, `concurrency`, `sessions`,
`realtime`, `wardrobe`, `action-form-url`, `room-migration-backfill`,
`persistence`) was updated to request `?enter=1` explicitly, since each of
them inspects the room view as its own setup step, not the question this
change is actually about — the same mechanical, non-behavioural update
Decision 13 itself already required of these same files when rooms were
first introduced.

## Decision 14 — Milo milestones: a shared, unranked progress track

**Decision.** `creature.total_care_actions` (`src/lib/schema.ts`) is a new,
never-pruned, per-room lifetime counter: +1 inside the same transaction as
every successful `feed`/`play`/`walk`/`clean`/`sleep`/adventure, never for a
rejected action, never for a wardrobe change. Five fixed, ascending
thresholds (10/50/100/250/500 — `src/lib/creature.ts`'s `CARE_MILESTONES`)
each unlock one short flavor-text label (`MILESTONE_LABELS`) — no stat
boost, no new wardrobe item, no gameplay effect of any kind. The room view
shows the current total and a progress bar toward the next threshold,
phrased "Room care so far," never "You've" — the room's own number, the
same scope `hunger`/`hat` already have, never joined against `sessions` or
broken down by visitor anywhere.

**Why this was raised at all.** Raised directly by the person running this
project: with no end goal, a room's Milo can be fed/played/walked/cleaned/
slept forever with nothing to work toward — "what's the point?" This is a
genuine tension with this app's own founding thesis (Decision 1's "one
persistent being, not one per user," and this file's own opening framing of
"good" as collective responsibility made visible, not competition). Rather
than resolve that tension unilaterally, the person was asked to choose
explicitly between three concrete directions: (a) milestones for Milo, a
room-level shared goal with no per-visitor ranking; (b) a competitive,
per-visitor scoring/achievement system; or (c) something else entirely. They
chose (a) — explicitly, after the tension was named — and this decision
implements exactly that choice, not a unilateral reinterpretation of the
brief.

**Why this does not reopen Decision 6 ("shared custody must be visible,
never a leaderboard").** Decision 6 rules out per-user scores, rankings, or
anything that invites comparing visitors against each other — its stated
purpose is defending against this concept reading as "a Tamagotchi clone
with a chat log bolted on." `total_care_actions` is scoped to the room's one
shared creature, never to a session: it is never read alongside
`lastActorSessionId`, never joined against `sessions`, and the UI phrasing
(`spec/milestones.test.ts`'s "never attributed to a visitor" tests assert
this directly — the rendered milestone text is checked to never contain a
session's display label, even in the same request where other fields on the
same page legitimately do) makes this the cumulative-count analogue of the
already-approved, unranked "Recent care" history (Decision 6 itself), not a
new kind of comparison. CLAUDE.md's out-of-scope "no leaderboards,
achievements... or AI" line is read the same way it already had to be read
for Decision 13's room pivot: written when every such feature would
necessarily have meant ranking one visitor against another, because there
was no other scope for "achievement" to mean. A room-level, unranked total
was not something that line was ever written to rule out, the same way
"multiple creatures" being out of scope never meant "multiple rooms" once
rooms became the explicit unit of sharing (Decision 13).

**Why a new counter, not something derived.** `care_events` (Decision 8) and
`log_events` (Decision 13's follow-up) are both deliberately bounded and
pruned on insert — neither can ever answer "how many successful actions has
this room performed, total," once that total passes either cap. Reusing
`age.ts`'s existing time-since-first-visit milestones was considered and
rejected: age and care are different axes, and conflating them would let a
room "age up" after a month of total neglect — the opposite of what a care
milestone should reward. A single integer, incremented in place, has none
of a row-per-event table's unbounded-growth risk, so it's the only correct
mechanism for a true lifetime total.

**Why wardrobe changes don't count, but adventures do.** A wardrobe change
is cosmetic, free, and never gated by any rule (Decision 11) — counting it
toward the total would make the milestone trivially farmable by flipping a
hat on and off with no real cost or effort, undermining "something the room
worked toward" entirely. An adventure (Decision 12) is a genuine shared
activity with a real, felt stat cost (its cleanliness hit is the single
largest in the app), the same category of real action as the five care
actions — excluding it would arbitrarily shrink the "together" this feature
is meant to measure.

**Migration.** `drizzle/0005_peaceful_black_cat.sql` — a single additive
`ALTER TABLE creature ADD total_care_actions integer DEFAULT 0 NOT NULL`,
no table rebuild, no hand-written backfill script: SQLite's own
`DEFAULT 0 NOT NULL` gives every pre-existing room's row 0 automatically.
Stated plainly, not glossed over: an existing room's milestone progress
starts at 0 from this point forward, never reconstructed from
`care_events`/`log_events` history — both are capped, so any such
reconstruction would under-report for a room that had ever exceeded either
cap, making a guessed starting value actively misleading rather than merely
incomplete.

While building this, adding a migration after `drizzle/0004_*.sql`
reproduced the exact bug class `spec/room-migration-backfill.test.ts`'s own
comment already documents for the rooms migration:
`spec/log-events-migration.test.ts`'s own simulation filtered "pre-log_events
migrations" by *name* (excluding the log_events migration's tag) rather than
by *journal timestamp position* — harmless until a later migration (this
one) was added, at which point drizzle-kit's migrator (which tracks
"already applied" against the single most recent migration's timestamp, not
which specific files ran) would have silently skipped the log_events
migration entirely on a real full pass. Caught immediately because that
test runs the full real migration set and asserts on its actual result, the
same standard this file's own prior incidents already hold every migration
test to. Fixed the same way the rooms-migration test was fixed: filter by
timestamp position relative to the migration being isolated, never by name.

**Tests.** `spec/milestones.test.ts`: a fresh room starts at 0 with no
milestone reached; a successful action increments by exactly 1; a rejected
action changes nothing; a wardrobe change does not increment; an adventure
does; crossing threshold 10 exactly at the 10th successful action (not the
9th); the milestone text never contains a visitor's display label even
while other fields on the same page legitimately do; two different sessions
in the same room see the identical shared total; and — reusing
`spec/concurrency.test.ts`'s genuinely-concurrent `Promise.all` standard —
the final total under real concurrent requests equals exactly the number
that actually succeeded, with none lost to a race. `spec/milestones-
migration.test.ts`: the column exists with the right default on a fresh
database, and an already-roomed database's existing creature row is
backfilled to exactly 0 with every other column untouched.

## Decision 15 — five appearances, one shared creature

**Decision.** The room's one shared creature can now look like one of five
fixed, authored animals — Milo (the original, default), Plip (a penguin),
Bella (a kitten), Simbaa (a lamb), or Oliver (a rabbit) — switched by any
visitor in the room via a new `creature.appearance` column (`text`, not
null, default `'milo'`) and `src/pages/api/appearance.ts`. This is **not**
a second creature, a per-visitor pet, or five independent rooms' worth of
state: switching appearance changes exactly one column on the one existing
`creature` row, nothing else. Stats, condition, XP/level (Decision 16),
the room's milestone total, equipped accessories, and care history are all
completely unaffected by which appearance is currently selected — the same
one `creature` row, the same one set of numbers, just rendered by a
different one of five sibling Astro components (`src/components/{Milo,
Plip,Bella,Simbaa,Oliver}.astro`) dispatched through a new
`CreatureDisplay.astro`.

**Why this reads as a pivot worth writing down, not a quiet contradiction.**
CLAUDE.md said, verbatim, before this decision: *"Don't read this as
license to add a second creature within one room, a per-user pet, or
anything else this list otherwise still rules out."* That line is about
**identity and ownership** — one shared being per room, not fragmented
into several — and it still holds exactly as written: there is still
`creature.roomId UNIQUE`, still exactly one row per room, still no
per-visitor anything. What changed is purely cosmetic: which of five
authored SVGs that one row's state is drawn as, the same category of
choice `hat`/`neckwear` already were. CLAUDE.md is updated alongside this
decision to say so explicitly, the same way Decision 13 updated it for the
room pivot rather than letting the code silently drift from stated rules.

**Why a new column, not a new table.** A literal "five animals per room"
reading of the original feature request was considered and rejected after
checking it against this app's own established rules first: it would have
meant either five `creature` rows per room (breaking the `roomId UNIQUE`
constraint load-bearing throughout `src/lib/db.ts`'s `readRow`/`toState`/
`performAction`, none of which have any notion of "which of several
creatures") or an entirely new `animals` table with its own stats/xp/
history, duplicating every mechanism (concurrency-safe transactions,
milestone tracking, wardrobe, SSE broadcast) this app already has working
and tested for one creature. Confirmed directly with the person running
this project before building anything: the five animals are **appearances
for the one shared creature**, not five independent creatures — a much
smaller, lower-risk change that needed zero new tables and zero changes to
the `roomId UNIQUE` constraint.

**Migration.** `drizzle/0006_yielding_thunderball.sql` — four purely
additive `ALTER TABLE ... ADD ...` statements (`creature.appearance`,
`creature.xp` — Decision 16, `creature.glasses`, `care_events.appearance`),
no table rebuild, the same low-risk shape `drizzle/0005_*.sql` (milestones)
already used. SQLite's own column defaults (`'milo'`, `0`) give every
pre-existing room the correct starting values with no hand-written
backfill: `'milo'` is the honest answer for "what did this room look like
before appearances existed" (it's the only appearance that has ever
existed), and `0` xp is Decision 16's own honest starting point. Verified
against the same journal-timestamp-cut harness `spec/room-migration-
backfill.test.ts`/`spec/log-events-migration.test.ts`/`spec/milestones-
migration.test.ts` already established, in a new `spec/appearance-xp-
migration.test.ts`.

**Equipped accessories are shared, global state — independent of which
appearance is selected, and switching never clears or re-validates them.**
If the newly-selected appearance's component has no rendering branch for a
currently-equipped item (the one deliberate case: `bunny-ears` is excluded
from `oliver`'s compatible list in `src/lib/creature.ts`'s `ACCESSORIES`,
since Oliver is already a rabbit — Decision 16), that appearance's
component simply draws nothing for that slot; the stored value is
untouched, so switching back to a compatible appearance shows it again
with no data loss. This was a genuine design choice, not an unexamined
edge case: the alternative (clearing an incompatible slot on switch) would
mean a visitor's wardrobe choice could be silently destroyed by another
visitor's unrelated choice of appearance, which is exactly the kind of
one-visitor-undoes-another's-work bug Decision 4's whole transaction model
exists to prevent for stats.

**History attribution.** `care_events.appearance` captures which
appearance was active **at the moment of that action** — the same
"capture now, independent of what changes later" principle
`care_events.roomId` already follows for room membership (CLAUDE.md). A
later appearance switch never retroactively changes what an earlier
history row says; `spec/appearance.test.ts` proves this directly (feed
while "milo," switch to "bella," clean, switch to "oliver" — the feed
entry still says Milo, the clean entry still says Bella).

**Why no shared base component.** `Milo.astro` had no existing extraction
seam, and the four new components (`Plip`/`Bella`/`Simbaa`/`Oliver.astro`)
were each built by duplicating its proven skeleton (mood-driven face
branching via the already species-agnostic `computeMood()`, the
always-rendered-but-hidden reaction-mark pattern, a scoped `<style>` block
with its own mood-tinted palette) rather than refactoring it into a shared
base purely to support this feature. Reusing a component correctly already
tested and shipped carries real regression risk for marginal benefit; four
~400–600 line files of explicit, readable markup is a better trade than a
parametrized abstraction invented for exactly five call sites.

**Two real rendering bugs found and fixed during visual verification, not
assumed correct from reading the markup.** (1) Every new creature
component's glasses accessory was drawn *before* the face-expression
group in source order — SVG painter's-order semantics mean later elements
draw on top, so the face's own eye shapes silently painted over the
glasses every time, making them invisible regardless of what was equipped.
Found by actually rendering a creature with glasses equipped and looking
at the screenshot; the code read as correct. Fixed by moving every
glasses block to render after the face, and locked in by a new assertion
in `spec/wardrobe.test.ts` checking the actual rendered class is present.
(2) Simbaa's hand-rolled wool-silhouette path left her legs visibly
disconnected from the body with a gap between them, and Oliver's first,
taller ear geometry clipped upward past the SVG's own frame into the
heading text rendered above it on the page. Both were visible only once
actually screenshotted; both were fixed (Simbaa's body reuses Milo's own
proven oval shape with small scalloped circles layered on for a woolly
texture; Oliver's ears were shortened to stay inside the viewBox) and
re-verified with fresh screenshots before being considered done.

**Tests.** `spec/appearance.test.ts`: switching changes only `appearance`
(stats/xp/milestones/equipped wardrobe/history length identical before and
after, aside from the one new history row the switch itself adds); an
unknown appearance value rejected (400) with nothing changed; switching
with no room yet rejected (403); the switch is visible to every session in
the room through the same `refreshLiveState()`/SSE mechanism every other
change already uses; cross-room isolation (switching or earning xp in one
room never touches a different room); and history attribution survives a
later switch. `spec/realtime.test.ts` gained one test confirming a switch
broadcasts the same `event: update` signal any other mutation does.
`spec/wardrobe.test.ts` gained the glasses-rendering regression above.

**Follow-up: Simbaa's silhouette didn't actually read as a lamb, and was
redesigned.** Reported directly, with a reference image of the intended
look: the original fleece shape (a plain oval body — the same base path
`Milo.astro` uses for its body — with ten small circles placed around its
outline) read as "a round character with circular decorations," not
fleece, exactly because that's what it structurally was: decorations on a
smooth shape, not a textured shape in its own right. No amount of adding
more circles to that same oval would have fixed the underlying problem, so
the fix was a real re-draw, not a parameter tweak.

The new silhouette is two genuinely scalloped cloud shapes (one for the
head, one for the body) — each built by placing points evenly around an
ellipse and connecting every consecutive pair with an **outward-bulging
circular arc**, the standard cloud/fleece-outline construction, rather
than a smooth curve with separate decorations layered on top. This was
verified geometrically before being written into the component at all: a
standalone script generated several candidate shapes at different
bump-counts and bulge amounts, each one actually rendered to an image and
visually compared, before picking the version that reads as "fluffy
tufts" (9–10 bumps, moderate bulge) rather than either a smooth blob (too
few/shallow) or a spiky star (too many/sharp or the wrong curve type
entirely — an earlier attempt using a sinusoidal radius modulation instead
of arcs produced pointed, star-like bumps, confirmed wrong by rendering it
before it ever reached the component).

Also new, and never present in the original design at all: a distinct,
lighter face plate sits on top of the head fleece, so the face reads as
skin rather than being the same wool-colored surface as everything around
it — floppy ears extending sideways (rotated ~55° from vertical, not the
small upright drop-ears the original used, which read as generic "pet
ears" rather than lamb ears specifically) with warm pink inner-ear detail;
a rounded, soft-edged nose shape (replacing a plain pink ellipse); and
visible dark-brown hooves as their own element distinct from the leg
above them. Every mood expression, wardrobe item, and reaction mark was
repositioned to the new face/body geometry rather than left at the old
coordinates — re-checked by rendering every mood family and every
compatible accessory, not assumed to still line up after the shape
changed.

**Nothing else changed.** Only `src/components/Simbaa.astro` — same Props
shape, same `computeMood()` dispatch, same reaction-mark pattern, same
accessory id vocabulary (`ACCESSORIES` in `src/lib/creature.ts` untouched).
No schema change, no migration, no change to stats/xp/milestones/
appearance-switching logic, no change to the other four creature
components. Verified by rendering the actual running app (not just reading
the new SVG paths): the redesigned lamb at normal size, at the small size
the SVG renders at inline, asleep, and wearing two different full
accessory sets (golden crown/heart glasses/knit scarf, and top hat/round
glasses/bow tie) — confirming the face stays visible and uncovered, the
character stays centered and proportionate in the existing creature-panel
layout, and the other four appearances and the appearance selector itself
are visually unaffected. Full suite re-run after the change: 113/113
still passing, with no test needing updating (the redesign didn't change
any class name the test suite depends on, only path/coordinate data).

**Second follow-up: the redesigned lamb's face was still too small and
dark relative to its ears.** Reported directly, with a reference image and
a screenshot of the result from the first redesign to compare against: the
face plate (27×24, against an eye fill colored the same near-black as the
outline strokes) read as "a small dark patch surrounded by wool and
flanked by oversized ears," not "a large, friendly, lamb-like face."

Fixed with three changes, each checked by rendering several candidates
before picking one — not guessed and shipped: the face plate enlarged to
29×27 against the same head-fleece radius (the single biggest lever for
"face fills most of the head"); every mood branch's eyes given their own
warm-brown fill (`--simbaa-eye`, `#6b4226`) distinct from
`--simbaa-outline`'s near-black, and each eye's own `rx`/`ry` reduced by
10% — large eyes filled with the same tone as the surrounding linework is
itself what reads as "a dark mask," independent of the face's own size;
and the ears reduced roughly 30% (`rx` 16→11, `ry` 24→17) while keeping
the same diagonal, floppy, pink-lined shape, so they stay recognisably
lamb-like without visually competing with the now-larger face. A
standalone script generated several face-size/ear-size combinations,
rendered each to a PNG, and compared them side by side before any of these
numbers were written into the component — the same verify-before-commit
discipline the original scalloped-fleece shape was chosen with.

Accessory positions (glasses centered on the eyes, hat anchored to the
head's top) needed no change: both were already keyed to the same `cx`
values the eyes/head still use, so they continued to line up correctly
once rendered and checked directly — confirmed with a full accessory set
(golden crown, round glasses, scarf) on the now-larger face, not assumed.
Full suite re-run again: 113/113 passing, only `src/components/
Simbaa.astro` touched.

**Third follow-up: Milo himself — the original, default appearance — was
redesigned to actually read as a dog, not a generic rounded creature.**
Reported directly, with a reference puppy illustration. Root cause
diagnosed by direct measurement, not assumption: the old ear shapes
(`rx` 15 / an asymmetric path roughly 15–21 wide) sat against a body
spanning roughly `x=26` to `x=134` — narrower than the body itself and
positioned almost entirely behind it, so neither ear was ever visible as
its own shape once the body was drawn on top. A silhouette with no visible
ears, one uniform body color, and no muzzle is exactly what reads as "a
generic round pet," independent of the face drawn on top of it.

Fixed with new floppy-ear teardrop paths, anchored high on the head and
drooping down and OUTWARD well past the body's own width — deliberately
made large enough that a real, visible sliver of ear shows on both sides,
confirmed by rendering several candidate sizes (three full iterations,
each one screenshotted) before the final shape was chosen, the same
discipline every other appearance's geometry in this file was already
held to. A distinct cream muzzle (a separate ellipse layered on the head,
not just a color change to the same body shape) is the other main fix —
it was this detail's complete absence, not just small ears, that let the
previous design read as "bear" rather than "dog." The ears are also given
their own, deliberately darker tan (`--milo-ear`) instead of reusing the
body's own fill, so they read as a distinct feature rather than blending
into the silhouette around them. A small dark nose and an open, happy
mouth with a visible pink tongue were added to the two warmest mood
states (`happy`/`excited`), matching the reference; every other mood
state keeps its existing expression logic, now drawn against the new
muzzle/nose geometry instead of the old plain face area.

Also fixed in the same pass, following Simbaa's own second follow-up: eye
fill moved from `--milo-outline`'s near-black to a dedicated warm brown
(`--milo-eye`), since a large eye in the same tone as the surrounding
linework reads as a dominating dark mask regardless of the eye's own
size — the same lesson already learned and documented above, applied
here before anyone had to report it a second time for a second
appearance.

**The body silhouette itself was deliberately left unchanged.** It was
never the part of the original design that read wrong — isolating the fix
to the ears, muzzle, nose, mouth, and eye color (not a full re-draw) is
both the more conservative change and what keeps Milo's overall
proportions consistent with the "body path reused across appearances"
pattern the other four already establish.

**Accessories.** Hat/neckwear positions needed no change — all are
anchored above/below the head-body boundary, which didn't move. Glasses
were repositioned from `cy=76` to `cy=68` to track the eyes' own slightly
higher position in the new face layout (confirmed by rendering: equipped
glasses now sit directly over the new eye position rather than floating
below it).

**Tests.** `spec/wardrobe.test.ts` gained one new test asserting the three
puppy-specific elements (`.milo-ear` ×2, `.milo-muzzle`, `.milo-nose`)
are present on a freshly hosted room's default Milo — a markup-level
regression guard against this exact "silhouette lost its distinguishing
features" class of bug, though (stated plainly) it cannot by itself prove
the ears are large enough to read correctly; that was verified by
rendering and visually comparing screenshots, the same way every
appearance redesign in this file has been. All five existing wardrobe
tests (`.milo-hat-top`, `.milo-scarf`, `.milo-hat-party`, `.milo-bow-tie`,
`.milo-round-glasses`) still pass unchanged, since every one of those
class names was preserved. Full suite: 114/114 passing. Verified by
rendering: Milo at normal size, at the small size the SVG renders at
inline, asleep, low-energy (sleepy-family), messy, and wearing a full
accessory set (golden crown, round glasses, bow tie) — face, muzzle, and
mouth stay visible and unobscured in every case; the entry page's own
decorative Milo illustration (`src/pages/index.astro`, unrelated code,
same component) was also re-checked and renders correctly with no change
needed there. The other four appearances and the appearance selector are
visually unaffected — only `src/components/Milo.astro` was touched.

## Decision 16 — shared XP, levels, and level-gated accessories

**Decision.** The room's one shared creature now has a second, independent
progress axis alongside Decision 14's milestone total: a cumulative
`creature.xp` integer (never decremented, never itself capped), and a
**derived, never-stored** level 1–5 computed from it by one pure function,
`getProgression()` (`src/lib/creature.ts`). A successful `feed`/`play`/
`walk`/`clean`/`sleep`/`adventure` awards a flat `+20` xp; a rejected
action or a cosmetic wardrobe/appearance change awards none. Five hats,
two glasses styles, and three neckwear items are gated by the level
reached, reusing `src/lib/creature.ts`'s `ACCESSORIES` registry, each
entry declaring an `unlockLevel` and which of the five appearances its
artwork actually supports; the level-5 golden crown is the one item this
feature's brief explicitly called for.

**Why a second track, not a replacement for Decision 14's milestones, and
why confirmed with the project owner rather than assumed.** Both read the
same underlying event (a genuinely successful action), but they answer
different questions and were kept deliberately separate after asking,
rather than guessing: `total_care_actions`/milestones is "how much care
has this room given, ever" (an open-ended lifetime count with flavor-text
labels at five points along the way); xp/level is "how far has this room
progressed toward a fixed, capped goal" (bounded at level 5, with concrete
unlocks attached). Merging them would force one number to carry two
different shapes of meaning — unbounded vs. capped — that don't actually
match.

**Why a flat `+20` per action, not a per-action table.** Confirmed with
the project owner as the simpler of two real options, rather than invented
unilaterally: varying xp per action (rewarding `adventure`'s real
cleanliness cost more than `clean`'s zero cost, for instance) was
considered, but every action already has its own, separately-designed
trade-off table (Decision 3) — adding a second, xp-specific weighting on
top would mean two independent "which actions matter more" systems that
could drift out of sync with no single source of truth for either. A flat
award keeps "how many actions has this room taken" and "how much xp has
this room earned" as the same number scaled by a constant, which is also
exactly what keeps no single action "the efficient one to spam" (the
brief's own stated goal) — spamming the free, always-available `clean`
earns identical xp to the costlier `play`/`walk`/`sleep`/`adventure`, so
there's no incentive to prefer it over genuinely caring for every stat.

**The cumulative thresholds, read correctly against the brief.** The
brief's 100/200/300/400 figures are XP *required for each transition*
(level 1→2, 2→3, 3→4, 4→5), not cumulative lifetime totals — so the actual
cumulative floors `LEVEL_XP_THRESHOLDS` stores are their running sum: 0,
100, 300, 600, 1000. `getProgression()` is unit-tested at every one of
these boundaries (`spec/progression.test.ts`) specifically because this
off-by-one-interpretation risk (requiring vs. cumulative) is exactly the
kind of thing that's easy to get quietly wrong and hard to notice later.

**Why `level` is derived, never a stored column.** The exact same
"compute it fresh from the numbers that are actually stored, never cache
or duplicate it" principle `deriveHealth()` already established for
`health`/condition (Decision 2) — `xp` is the one authoritative value;
`level`, `xpIntoLevel`, and the progress-bar percentage are all recomputed
from it on every read (`toState()`, `src/lib/db.ts`), so there is no
second value that could ever drift out of sync with the real one.

**Concurrency.** Awarded inside the exact same single, synchronous
`db.transaction` every other `creature` write already uses (Decision 4) —
a plain SQL increment (`xp: sql\`${creature.xp} + ${XP_PER_ACTION}\``),
identical in shape to `totalCareActions`'s own increment on the very same
line, so it inherits that mechanism's existing guarantee against lost
updates under real concurrent requests with zero new code. Extended the
existing genuinely-concurrent `Promise.all` standard
(`spec/concurrency.test.ts`/`spec/milestones.test.ts`) to `spec/
xp-awards.test.ts` to prove this directly rather than assume it transfers.

**Accessory validation moved from static to dynamic, inside the
transaction.** Before this decision, `api/wardrobe.ts` validated a
slot/value pair entirely statically (is this one of two fixed strings) —
there was no state-dependent eligibility rule to check. Now whether an
accessory can be equipped depends on the room's *live* level and *current*
appearance, both of which can only be read correctly from inside the same
transaction that performs the write (the same "always derive from a fresh
read inside the transaction" principle Decision 4 already established for
stats) — so `performWardrobeChange` (`src/lib/db.ts`) now reads the row,
computes `getProgression(row.xp).level`, and rejects with the same
`{reason}` shape `performAction` already uses (surfaced as a `409`,
never a silent no-op) when an item's `unlockLevel` exceeds the room's
level or its `compatible` list excludes the room's current appearance.
The one deliberately-chosen, tested example of species incompatibility is
`bunny-ears` excluded from `oliver` (he's already a rabbit) — kept to one
clear case rather than inventing many borderline ones, to keep this
feature's scope controlled while still proving the mechanism works
end-to-end.

**No persisted "unlocked" state at all.** Whether an accessory is
currently available is a pure function of `(level, appearance)` checked
against the static `ACCESSORIES` registry — the same derive-don't-
duplicate principle this decision's own `level` field already follows for
`xp`. "Unlocked accessories persist across sessions and restarts" falls
out for free, since `xp` already does; there is no separate per-room
unlock-tracking table to keep in sync or to ever disagree with the real
source of truth.

**UI.** Locked items are shown, not hidden, with a `"— Level N"` suffix
and a `disabled` button (defense in depth — the server's own check is the
real authority, never relied on alone), per the brief's explicit
requirement that a locked item stay discoverable rather than silently
vanish. The XP bar shows `Level N · X / Y XP` with real numbers (never
color-only) and a `role="progressbar"` element carrying `aria-valuenow/
min/max`; at the level cap it shows a distinct "max level" state instead
of a bar that looks perpetually full with no visible ceiling.

**Tests.** `spec/progression.test.ts`: every level boundary (including the
exact cumulative thresholds, never one xp early or late), the four
transition widths matching the brief's 100/200/300/400 figures, the
level-5 cap holding under an arbitrarily large xp value, and a single
multi-level jump landing correctly. `spec/xp-awards.test.ts`: a fresh room
starts at level 1/0xp; each of the six real interactions awards exactly 20
on success and 0 on rejection; wardrobe and appearance changes award 0;
leveling up at exactly the action that crosses a threshold; a level-gated
item rejected before and accepted after the room reaches that level; the
golden crown rejected below level 5; `bunny-ears` rejected for the
`oliver` appearance even at a qualifying level; and the existing
genuinely-concurrent standard extended to xp.

## Decision 17 — contextual care suggestions: read-only, derived, not coordination

**Decision.** `src/components/suggestions.ts`'s `suggestNextCare(stats,
activity)` is a pure function that reads the four already-displayed stats
and returns up to two short, friendly suggestions ("A Feed might help —
fullness is getting low"), shown as one new sibling paragraph next to the
existing `.last-action` line (`src/pages/index.astro`). It stores nothing,
broadcasts nothing, and gates nothing — every stat it reads is already
rendered as a number on the same page; this only adds a plain-language
reading of numbers a visitor could already see.

**Why this, not the fuller "Care Coordination" idea first proposed.** The
original proposal also included shared claim/release intentions (a room
member marking "I'll feed him") and a suggested daily schedule — a real
second subsystem: new schema, new transactions, a new SSE concern, a new
isolation-test surface. Checked against the actual COMP4020 final-project
brief (not just this file's own prior, stricter reading of it) before
building anything: the course's own spec doesn't name chat, accounts, or
coordination features as banned by name — "chat is out of scope" below is
this project's own self-imposed rule, not a course requirement. The real
risk the brief's rubric flags is the opposite kind of mistake: the
Response band explicitly rewards "one idea, carried all the way" and
penalizes being over- or under-scoped, with no feature checklist — nothing
earns marks just by existing, only by strengthening this app's own stated
definition of good. Six days out from the final deadline, with several
existing systems (appearances, XP/levels, milestones) already carrying
that definition, adding a second claim/release subsystem risked diluting
rather than sharpening it. The claim/release intentions model and the
suggested schedule are deferred, not rejected outright — the same
treatment Decision 3 already gave the neglect callout.

**Why it reuses `applyAction`'s real thresholds, not new ones.**
`ENERGY_FOR_PLAY`, `ENERGY_FOR_WALK` (unused by this feature — `play` is
the only play/walk-family suggestion it makes), and `HUNGER_TO_SLEEP`
(`src/lib/creature.ts`) are now exported so `suggestNextCare` can gate a
suggestion against the exact same number `applyAction` would reject it
with. A suggestion recommending an action the server would immediately
refuse would be actively misleading, not merely unhelpful — the spec for
this feature said so explicitly, and it's the one correctness property a
read-only hint like this genuinely needs. The "worth mentioning at all"
threshold reuses `MOOD_CONCERN` (`src/components/mood.ts`) so a suggestion
never disagrees with what the creature's own face/dialogue is already
visually communicating.

**Why it lives in `src/components/`, not `src/lib/`.** Same reasoning
`mood.ts` and `dialogue.ts` already establish: `src/lib/*` is CLAUDE.md's
validated, authoritative business-logic layer, and this never accepts or
rejects an action — it's a read of public state, not a rule.

**Tests.** `spec/care-suggestion.test.ts` — pure unit coverage of
`suggestNextCare()` alone (no server needed, same shape as
`spec/progression.test.ts`): nothing suggested while asleep or while every
stat is comfortably high; `feed`/`clean` always eligible once their stat
is low; `play` never suggested below its real energy threshold, suggested
once that threshold is actually met; `sleep` never suggested below its
real hunger threshold, suggested once that threshold is actually met; the
worst stat's suggestion sorts first when several are low; never more than
two suggestions at once.

## Audit — accessibility and progressive enhancement, verified not assumed (2026-11-03)

A rubric self-assessment found that progressive enhancement, keyboard
accessibility, and focus visibility were implemented but neither claimed
nor evidenced anywhere in this file — the silence read as an unconsidered
gap rather than a verified property. This audit checks each one against
the actual running app, not against reading the source and assuming it
works, and states plainly what was and wasn't checked. Nothing in the
application changed to produce these findings.

**Progressive enhancement — verified with real JavaScript disabled.** With
`javaScriptEnabled: false`, a real browser session both hosted a fresh room
and performed a real care action (`feed`), each completing via the plain
`<form method="post">` + 303-redirect round trip that
`src/pages/api/actions.ts`'s own comment already describes ("the same POST
+ 303 shape the course's other starter uses, so the core loop needs no
client JavaScript"). This is the first point that claim was actually
checked against a real browser with JavaScript off, rather than only read
and trusted — stats and "Last action" both updated correctly with no
client-side script running at all. **Stated limitation:** the "● live" /
"connecting..." badge correctly does nothing without JavaScript, since
live updates depend entirely on the client-side `EventSource` connection
`src/pages/index.astro` opens (`src/lib/sse.ts`'s server side has no
fallback delivery mechanism for a client that never makes that
connection), and there is no separate `<noscript>` message explaining that
absence to a no-JS visitor — a real, minor gap, not a false claim.

**Keyboard accessibility — verified by actually tabbing through and
activating a control.** A real browser session tabbed through the room
view from a fresh page load: every interactive control (the three nav
links, the five appearance-picker buttons, every wardrobe-slot button, the
adventure button, and all five care-action buttons) was reached via `Tab`
in a sensible top-to-bottom, left-to-right order, each with a visibly
rendered `outline: 2px solid` focus ring confirmed via the element's
actual computed style, not by reading the CSS alone (`a:focus-visible,
button:focus-visible` — `src/styles.css`). The `Feed` button was then
actually activated with `Enter` alone (no mouse), and `.last-action`'s
text changed to confirm the action genuinely ran. **Not yet checked:** no
automated accessibility test (axe-core or equivalent) exists in `spec/` —
this audit is a manual, one-time verification pass, not a regression
guard; a future visual change could reintroduce a focus-order or
visibility regression with nothing here to catch it.

**Color contrast — computed directly from the real values in
`src/styles.css`**, not assumed from how the colors look, for these three
specific text/background pairs only — not a claim about every color
combination this stylesheet defines, several of which (e.g. stat-bar
hues, badge backgrounds) were not checked: muted text (`--color-muted:
#7a6f60`) against both the white panel background and the cream
`--color-surface-alt` background, body text (`--color-text: #2b2420`)
against white, and the accent-ink link color (`--color-accent-ink:
#b84b22`) against white. All three checked pairs clear WCAG AA's 4.5:1
ratio for normal text (lowest measured: 4.66:1, muted text on the cream
surface variant).

**Semantic HTML / accessible names — already real, confirmed present, not
re-implemented here.** `role="group"` + `aria-label` on both the
appearance picker and each wardrobe slot; `aria-pressed` on every toggle
button reflecting its real selected state; `role="progressbar"` with
genuine `aria-valuenow`/`aria-valuemin`/`aria-valuemax` on the XP bar;
`aria-live="polite"` + `role="alert"` on both error regions (entry-page
and action-rejection); every decorative icon (`ActionIcon.astro`,
`StatIcon.astro`) marked `aria-hidden="true"` since its accessible name is
always the visible text label beside it, never the icon alone.

**Not addressed at all — stated as a gap, not glossed over.** No stated
claim and no test exists anywhere in this repo for behavior under slow or
interrupted network conditions (no request timeout handling, no
offline/retry messaging). This remains an open limitation.

**Manual viewport inspection — kept separate from the automated test
above, since a jsdom source check cannot see real layout.** Recorded here
as its own, explicitly manual, non-automated finding:
- **Desktop, ~1280×800** (the Playwright session's default viewport): room
  view, fresh room — three panels (Milo, actions + shared activities,
  Recent care) laid out left-to-right per the two/three-column grid
  breakpoints; no visible overlap, no clipped text, no horizontal
  scrollbar. Repeated after lowering stats via several `Play` actions:
  the new `.care-suggestion` line wraps cleanly beneath "Last action,"
  does not push the panel's height past its neighbors in a way that
  breaks the row layout, and reads distinctly from Milo's own dialogue
  line directly above it.
- **Mobile, 390×844** (iPhone-class viewport): single-column stacked
  layout (no breakpoint active below 46rem, by design — see the "desktop
  two-column layout" comment in `src/styles.css`); same fresh-room and
  lowered-stats checks repeated — no horizontal scroll, the suggestion
  line wraps onto two lines without clipping or overlapping the stat bars
  above or the "Recent care" card below it.
- This inspection is a one-time manual check, not a committed, re-runnable
  artifact — `spec/layout-structure.test.ts`'s structural checks are the
  only part of this that re-runs automatically on every `pnpm check`.

## Decision 18 — the Adventure runner: a playable interaction, not a sixth action

**Decision.** `src/components/AdventureGame.astro` (markup, screens,
lifecycle wiring) and `src/components/adventureGame.ts` (pure physics,
obstacle generation, collision, rendering, input) add a short, pixel-art
side-scrolling runner as the Adventure activity's interaction — not a new
action, not a new endpoint, not a new database table. `POST
/api/adventure` (`src/pages/api/adventure.ts`), `performAdventure`
(`src/lib/db.ts`), and `applyAdventure` (`src/lib/creature.ts`) are
completely unchanged: same deterministic deltas (energy −10, happiness
+15, cleanliness −30), same rejection rule (asleep only), same flat XP
award, same `care_events` row. The game's own in-run score (distance,
stars collected) is cosmetic, shown only on its own result screen, and is
never sent to the server — the "Return to Commons" confirm is the exact
same bodyless POST that existed before this feature, so "don't trust
client-submitted distance" holds by construction, not by new server-side
validation.

**Why a new pixel sprite system, not the existing SVG creature art.**
Checked directly before building anything: `src/components/{Milo,Plip,
Bella,Simbaa,Oliver}.astro` are smooth, cubic-Bézier-curve inline SVG —
floppy-ear teardrops, curled tails, rounded bodies — with no gradients or
filters to complicate things, but nothing pre-aligned to any pixel grid
either. Scaling and pixelating that art would crush its curves into
blobs, not produce deliberate pixel art. There is also no `public/` or
`src/assets/` directory anywhere in this repo and no image files at
all — no existing static-asset pipeline this feature could extend without
first building one from scratch. `adventureGame.ts` instead defines five
small, flat-color sprite palettes (`SPRITE_PALETTES`), each one echoing
its creature's real body color (e.g. Milo's `--milo-body: #f0b374`, Plip's
dark body/orange accents) without tracing or miniaturizing the SVG art —
a new, simple, blocky identity in the same spirit, drawn with plain
`ctx.fillRect` calls onto a small canvas (`imageSmoothingEnabled = false`,
CSS `image-rendering: pixelated`). Zero new dependencies, zero new asset
files, zero changes to `astro.config.ts`.

**Progressive enhancement, preserved not narrowed — corrected mid-design.**
An earlier draft of this feature would have made the Adventure activity's
one-click path require JavaScript, a real regression from every other
action on this page, each of which already works with JavaScript
disabled (the existing POST + 303 shape). Caught and corrected before
implementation: the real, only `.activity-form.adventure-form` — unchanged
action/hidden-input shape — is what server-rendered HTML shows by
default. A render-blocking script, if it runs at all, replaces that
default view with an ordinary-looking "Send X on an adventure" button in
its place; clicking THAT opens the game overlay. A no-JS or JS-disabled
visitor sees exactly what existed before this feature and is never worse
off. Verified directly with a real `javaScriptEnabled: false` browser
session: hosting a room and performing a real adventure both complete
exactly as they did before this feature, with the overlay never rendered
at all.

**A real bug, found only by actually clicking through it, not by reading
the code — recorded here per this project's own incident-documentation
habit.** The first working version revealed the full-screen overlay the
instant its own script ran, rather than only when the newly-added launch
button was actually clicked — meaning every page load with JavaScript
enabled threw up an unsolicited full-screen takeover over the entire
dashboard, and a Playwright script that happened to click the adventure
trigger immediately after each page load never exposed this, since it
never tried to interact with anything else first. Found by a script that
tried to switch the room's appearance before touching Adventure at all,
which timed out because the (invisible, `hidden`-but-click-intercepting)
overlay sat on top of the whole page. Root cause: `.adventure-overlay`'s
own `display: flex` rule outranked the browser's default `[hidden] {
display: none }` by specificity, so setting the `hidden` attribute alone
never actually removed it from the layout or from pointer-event handling.
Fixed by scoping that rule to `.adventure-overlay:not([hidden])` and,
separately, by restructuring the launch flow itself so the overlay is
never shown just because JavaScript ran — only an explicit click on the
plain launch button opens it. Both fixes verified by rendering: the
overlay stays genuinely absent (`hidden`, zero layout impact) until
clicked, and an unrelated action (Feed) performed right after page load
completes normally with no overlay in the way.

**A second real bug, found the same way.** `index.astro`'s
`refreshLiveState()` (PROCESS.md, Decision 5/Incident 1) replaces
`#live-state`'s entire subtree with freshly-*parsed* HTML after every
successful action — including, unavoidably, the Adventure activity's own
completion, since that is the same live-update path every other action
already goes through. A parsed-and-inserted `<script>` never re-executes,
so the very first adventure's own completion would silently strand every
subsequent one: the freshly-swapped-in markup would show the correct
no-JS fallback form again, but nothing would ever upgrade it back into
the game. Fixed with a `document`-level `MutationObserver` watching for
new `.adventure-game` nodes and re-running the same setup function on
each one, with a `data-adventure-wired` guard against double-wiring.
Verified by actually completing two full adventures in the same session,
back to back, confirming the second one plays and submits correctly
through the exact same re-wired form.

**Pause, Exit, and auto-pause.** `adventureGame.ts`'s returned controller
(`pause`/`resume`/`stop`/`isPaused`) is the ONE place input, physics, and
the `requestAnimationFrame` loop live — `AdventureGame.astro`'s own script
never attaches a second, competing listener for gameplay input; it only
calls into this controller and reacts to its callbacks. A
`visibilitychange` listener (added and removed entirely inside
`adventureGame.ts`) auto-pauses a run the instant the tab is backgrounded.
Exit calls `stop()` and returns to the dashboard without ever touching
`#live-state` or submitting anything — verified directly by watching the
browser's own network log through a full pause → resume → exit sequence
and confirming zero requests to `/api/adventure` fired.

**Obstacle fairness is a real, checked guarantee, not an assumption.**
`generateObstacles()`/`validateSequence()` reason about the whole upcoming
sequence, not just consecutive pairs: a ground obstacle forces a jump, a
bird forces NOT jumping, and the generator sizes the gap between any pair
of *conflicting* kinds against the game's `MAX_SPEED` (the fastest the
run ever reaches), not the speed at the point the gap was chosen — an
earlier version sized gaps against the LOCAL speed at generation time,
which a seeded test (`spec/adventure-game.test.ts`) caught failing at
higher speeds, since the real-time gap between two obstacles shrinks as
scroll speed ramps up even when the distance between them doesn't change.
`validateSequence()` is exercised independently of the generator across
many seeded sequences, so this is a checked guarantee about the
generator's output, not merely "the code looks like it should work."

**A visual-quality pass, done after the game was already functionally
complete — five more real bugs, each found only by actually rendering the
game, never by reading the code.** The first working version was
functionally correct but visually a prototype: a flat rectangle for the
player, flat-color-rectangle obstacles, an empty sky, and a star counter
permanently stuck at 0 because no collection mechanic existed yet. Fixed
entirely inside `adventureGame.ts`'s rendering layer and one small
addition (`generateStars`/star collision) — physics, collision rects,
`generateObstacles`/`validateSequence`, and the controller contract above
are all untouched by this pass. Every sprite (five creature heads, log,
rock, puddle, bird, star) is drawn through one shared `drawPixelGrid`
primitive from small hand-authored character grids, never an image file
or sprite library. Bugs found:

1. **Milo's ears read as raised arms.** The original `HEAD_MILO` grid put
   ear pixels at the same rows as the eyes, flanking the face rather than
   hanging from it — confirmed by an 8×-zoomed canvas screenshot. Fixed by
   redesigning the grid so the ears droop below the head's own bottom
   edge.
2. **The bird was an unrecognizable disconnected blob.** The original
   `BIRD_WINGS_UP`/`DOWN` grids had no coherent silhouette — confirmed by
   rendering the sprite in isolation. Redesigned as a simple chevron/V
   bird-in-flight shape, confirmed legible both in isolation and in a live
   run against the sky.
3. **The collision pose was never actually visible.** `finish("collision")`
   ran synchronously in the same tick as the hit-frame render, so the
   browser never painted that frame before the result screen replaced the
   canvas — confirmed by repeated, tightly-timed screenshot attempts that
   always landed on the result screen, never the hit. Fixed with a 450ms
   `setTimeout` hold between the hit render and calling `finish`, with the
   timer cleared in `stop()` so clicking Exit during that window can't race
   it into firing after cleanup.
4. **The star generator starved itself.** The original placement loop
   skipped a candidate position entirely if it fell within
   `STAR_OBSTACLE_MARGIN` of any obstacle, rather than retrying nearby —
   confirmed by a standalone simulation of the generator (2 stars for a
   full run instead of a realistic 11) and empirically in-browser (0
   stars ever collected across several real runs). Fixed with a
   nudge-forward retry loop (`STAR_NUDGE_STEP`/`STAR_MAX_NUDGES`); a
   regression test now asserts at least 5 stars per run across 20 seeds.
5. **The collection sparkle was functionally present but invisible.** A
   near-white pale yellow was indistinguishable from the sky — confirmed
   by direct `getImageData()` pixel sampling, not just a screenshot.
   Replaced with a bright, saturated orange and a longer-lived burst
   effect; the color's actual presence on canvas during a real collection
   was then re-confirmed the same way.
6. **A visible gap of flat sky between the distant hill band and the
   ground.** The hill tiles were drawn only down to `GROUND_Y`, but the
   ground itself starts `PLAYER_SIZE` pixels lower (`groundTopY`), leaving
   a flat strip of sky-colored canvas between the two layers in every
   frame — confirmed by inspecting a full-canvas screenshot, not visible
   at the scale of the dashboard's small game window. Fixed by extending
   each hill tile down to `groundTopY` instead of stopping at `GROUND_Y`.

Collectible stars are new, additive, and intentionally separate from
obstacle fairness: `generateStars()` is never consulted by
`validateSequence()` and never forces a jump/no-jump decision, since
missing one is never a `finish("collision")` — only a skipped pickup.
`collected` was already excluded from every request `/api/adventure`
sends (the game never submits a body at all), so making the number
genuinely count something real doesn't touch that boundary.

**Tests.** `spec/adventure-game.test.ts` — pure unit coverage of jump
physics, AABB collision (including edge-touching and bird-flying-band
cases), finish-line/collision outcome detection, the five-appearance
sprite-palette lookup, hand-authored sprite grid row-width consistency,
star placement (never within the obstacle margin, alternating
ground/air, at least 5 per run across many seeds), and the sequence-level
fairness guarantee (checked across many seeded runs spanning the full
speed range, not sampled once).
`spec/adventure.test.ts`'s existing three tests (exact deterministic
deltas, sleeping rejection, genuine concurrency) are untouched — they
exercise `/api/adventure` directly via `fetch`, bypassing the UI
entirely, so nothing about adding a game in front of that same endpoint
could affect them, and all three still pass unmodified.

**Explicitly manual, not automated, and verified in this session, not
assumed:** two independent browser sessions sharing a room, confirming a
completed adventure reaches the other session live via the existing
unmodified SSE path; all five appearances rendering with visually
distinct sprite palettes; desktop keyboard play and mobile tap-to-jump;
resizing the canvas mid-run without blur; and a real no-JS browser
session completing a full adventure through the plain fallback form with
the overlay never rendered. Not automated: a committed accessibility
test for the game's own controls, and behavior under a slow or
interrupted network connection during the "Return to Commons" submit —
stated as open limitations, not silently assumed to be fine.

## Out of scope for this deliverable (unchanged from the course's own list)

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, admin dashboards, machine learning — and, specific to this
concept, no leaderboards, achievements, shops, inventories, or AI. The
neglect callout (Decision 3) is the one idea considered and explicitly
deferred rather than rejected outright.

**"Multiple creatures," updated by Decision 13.** This line used to rule out
multiple creatures outright, back when "the room" meant the whole
deployment. It now means: no multiple creatures **within** a room — a room
still has exactly one shared creature, visible to and mutable by everyone
in it, with no per-user creature and no per-user ownership. What's allowed,
and deliberately built in Decision 13, is multiple *rooms*, each with its
own single creature, isolated from every other room's. This is the one
line in this list that changed meaning rather than being honoured as
originally written — recorded here, not silently reinterpreted.

## Incidents found via human playtesting

Three real bugs, found in this order, each with its own fix. Recorded
plainly, including what turned out not to be the cause, because the
sequence is itself the evidence the brief asks for: automated correctness
checks and human browser testing catch genuinely different things.

### Incident 1 — the live-state refresh wasn't one path

**Reported.** After a successful action, "Recent care" sometimes looked
stale while other state appeared to update.

**Investigation.** `#live-state`'s markup already correctly wrapped both
the stats and the history sections (confirmed directly against the
rendered output), so a selective, partial update wasn't structurally
possible. The real problems were upstream of the markup: the own-action
success path trusted `fetch()`'s *automatic* following of the POST's 303
redirect and used `res.ok` on the followed response as a proxy for
success; if that chain ever landed on a non-OK response for any reason,
its raw body — HTML included — would get read as the rejection "reason"
and shown to the visitor, and because `res.ok` was false, the success
reload never fired either. Separately, the actor's own action and the
other sessions' SSE-triggered updates ran through two different
mechanisms (`location.reload()` vs. a targeted refetch), which is exactly
the kind of divergence that lets two code paths silently drift apart.

**Fix** (`43016f5`). Both paths now go through one `refreshLiveState()`
function that always swaps the complete `#live-state`. Success is detected
via `res.redirected` (a 303 to `/` is the only way this server's
`/api/actions` response is ever followed), checked directly rather than
inferred from the followed response's eventual status. A rejection's body
is never rendered if its content-type is HTML. A monotonic sequence guard
in `refreshLiveState()` discards an out-of-order response from an
overlapping refresh, which matters once more than one person is acting at
once — the entire premise of this app.

### Incident 2 — activity-expiry resolution wasn't fully unified

**Reported.** A later human playtest showed the activity badge reading
"Milo is awake" at the same moment an action attempt was rejected.

**Investigation.** Extensive, deliberately adversarial reproduction before
any fix: five trials polling at the exact 8-second cooldown boundary and
firing an action inside that window: every one succeeded cleanly, no race
found. Every distinct rejection reason checked individually for
content-type and body: all `text/plain`, all non-empty — none could
produce a generic fallback message. Astro's own CSRF-rejection response
checked the same way. Multipart `FormData` bodies tested explicitly,
matching what a real form submission sends, not the url-encoded bodies
every script (including the existing spec suite) had used until then.
`res.redirected` checked against the actual production deployment, not
just localhost. **None of this reproduced a case where the GET/render path
and the POST/validate path actually disagreed on the decision** — both
already called the same `resolveActivity()` function, freshly, at request
time. What the investigation did find: `toState()` computed the lazy
sleep-to-idle resolution for display but never persisted it back to the
row, and `performAction()` only ever wrote state as a side effect of a
*successful* mutation — so the stored row could say "sleeping" with a
long-expired timestamp indefinitely, correct only because every reader
happened to independently re-derive the truth every time.

**Fix** (`11619a6`). `resolveAndSync()` is now the one function both the
read path and the write path call; it persists the sleep→idle transition
the moment it's discovered, including as a side effect of a *rejected*
action's validation (that write is housekeeping correcting time that's
already passed, not the action's own effect — it never touches stats or
`care_events`). The client's form handler now calls `refreshLiveState()`
after every attempt, success or rejection, so a rejection that reveals a
stale client view self-corrects immediately instead of leaving a
contradiction on screen.

**Honestly stated at the time, and still true in hindsight:** this fix
closed a real architectural gap and made the system more robust, but the
investigation never produced a reproducible case of the *exact* reported
symptom, and the symptom recurred after this fix shipped (see Incident 3).
This dead end is left in the record rather than quietly dropped.

### Incident 3 — the browser-only `form.action` bug

**Reported.** The same symptom as Incident 2, again, in production, after
Incident 2's fix had shipped and been verified both by scripted tests and
a server-side deployment check.

**Direction received.** Stop making speculative UI changes; do a forensic
diagnosis instead, against the live deployment, not another scripted
reproduction. When a hard reload of the live page didn't change anything,
that specific hypothesis (a stale, previously-loaded browser tab) was
explicitly ruled out and dropped — the instruction was not to re-assert it
and not to ask for another reload. The next instruction was explicit: do
not accept "cannot reproduce" as the conclusion, since the human browser
test had reproduced it repeatedly.

**What repeated scripted investigation established, and its limit.**
Every single-submission HTTP request against the live production app,
matching the real client's cookies, `Origin` header and multipart body
exactly, returned a clean `303` for all five actions, every time. The
server was provably correct and consistent. That consistency was itself
the signal that the missing variable had to be in the actual browser
runtime — something no script run from outside a real DOM could exercise.

**Diagnostic instrumentation** (`f76fee0`, fully removed by `a8d100c`).
Temporary, clearly-labelled client-side logging added to the one real
request path: on every action submission, logged (to the console and a
small on-page panel) which action was submitted, which branch the handler
took, `res.status`, `res.redirected`, `res.url`, the `Location` header,
`Content-Type`, and the first 200 characters of the body. Read a *clone*
of the response so the real logic was completely undisturbed; read no
cookie or session id. Deployed, and the student performed exactly one real
click in their own desktop Chrome.

**The captured evidence, verbatim:**
```
action: "feed"
branch: "rejection"
status: 404
redirected: false
url: "https://comp4020-final-abhayskahlon/[object%20HTMLInputElement]"
contentType: "text/html"
```

**Root cause, read directly off that evidence.** Each action form carries
a hidden input named `"action"` — the field the server validates against
(`src/lib/creature.ts`'s `ACTIONS`, `src/pages/api/actions.ts`'s
`form.get("action")`). Per the HTML/DOM "named property" algorithm, a form
control's `name` becomes a property on its form element, and in real
browsers that control **shadows** `HTMLFormElement`'s own built-in
`action` property: `form.action` stopped being the URL string and became
the `HTMLInputElement` itself, and `fetch(form.action, …)` silently
stringified that to `"[object HTMLInputElement]"` — a 404, whose HTML
content-type correctly (and, until diagnosed, misleadingly) tripped the
Incident 1 content-type guard, returning no reason to show. There was
never a real server rejection; the request never reached `/api/actions`
at all. This is exactly why no scripted HTTP test — not mine, not the
existing spec suite — ever reproduced it: none of them read `form.action`
from a real DOM. They all call `fetch()` with a hand-built URL string,
which was always correct, which is precisely why the server side kept
checking out clean.

**Fix** (`a8d100c`). Read `form.getAttribute("action")` instead of
`form.action` — the literal attribute value, never subject to
named-property shadowing. The `"action"` input was deliberately **not**
renamed: the server's whole validated vocabulary is built around that
field name and was always correct; the bug was purely in how the client
located the URL.

**Regression coverage** (`spec/action-form-url.test.ts`). Asserts every
action form's `getAttribute("action")` resolves to `/api/actions`; asserts
each form still carries the named `"action"` control (the condition that
caused the shadowing, so the test keeps meaning something); a static
source check that `fetch(form.action` never reappears. **Stated
limitation, in the test itself:** jsdom — this project's only DOM engine,
per its established no-mocking-library convention — does not reproduce
the shadowing; its `HTMLFormElement` implementation always returns the
reflected URL regardless of a same-named control. The test cannot
exercise the original failure directly; it proves the fixed path is
correct and guards against reverting to the broken one, which is what was
practical without real browser automation.

**Verified afterward:** the fix redeployed, and the student's own
two-browser playtest — Feed through all five actions, stats/Last
action/Recent care updating together, a second independent session
receiving the same update live via SSE with no reload, rejected actions
showing their specific reason, sleep's countdown and expiry — passed.

### Incident 4 — the sleep countdown was a second, un-resynced clock

**Reported.** Two real symptoms from the same human playtest: (1) two
browser tabs open on the same room's sleep showed different remaining-
seconds numbers for the exact same cooldown, and (2) after the countdown
visibly reached zero, the creature never actually woke up on its own — it
stayed asleep in the UI (badge stuck on "is waking up…", the sleeping SVG
pose unchanged) until someone performed an unrelated action or reloaded.

**Root cause.** `resolveActivity()` (`src/lib/creature.ts`) is, by design
(Decision 5), only ever invoked lazily — on the next GET or action POST
that happens to touch the creature, never on a timer. The client-side
`attachActivityCountdown()` (`src/pages/index.astro`) is a genuinely
separate clock: it reads `activityUntil` once, when the badge node is
attached, and ticks down locally via its own `setInterval`, with no
mechanism to ever ask the server again once it reaches zero. Two tabs that
attached their own countdown at different moments — or a tab backgrounded
long enough for the browser to throttle its timers — have no way to
converge on the same number, and none of them has any reason to recheck
the real server state once their own local countdown runs out, since
reaching zero was never wired to anything beyond changing displayed text.
This is a client-display gap, not a server inconsistency: `GET /` at any
moment already returns the correct, freshly-resolved state (the same
`resolveAndSync()` Incident 2 unified) — nothing was ever being asked.

**Fix.** Two additive changes to `src/pages/index.astro`, no change to
`src/lib/creature.ts` or `src/lib/db.ts` — the server-side resolution
Incident 2 already fixed was always correct:

1. The countdown's own `tick()` now calls `refreshLiveState()` once,
   exactly when its local remaining-seconds count reaches zero — the same
   full re-fetch-and-swap every other correction on this page already
   uses, not a new polling mechanism. This is what makes the creature
   actually wake up without requiring an unrelated action first: reaching
   zero now asks the server, rather than just changing displayed text and
   stopping.
2. A `visibilitychange` listener (the same pattern already established in
   `src/components/adventureGame.ts` for pausing on a hidden tab) calls
   `refreshLiveState()` whenever a tab becomes visible again. This is what
   closes the two-tabs-disagree gap: a tab that was backgrounded, or that
   missed an SSE event during a reconnect gap, always resyncs to the
   server's actual current state the moment it's looked at again, instead
   of trusting however far its own un-resynced local clock had drifted.

Neither change touches `activityUntil`'s meaning, the 8-second default
(`SLEEP_COOLDOWN_MS`), or `resolveActivity()`/`resolveAndSync()` — the
countdown was always cosmetic (PROCESS.md's own comment on
`attachActivityCountdown()` says so), and stays exactly that; it now just
reliably triggers the one existing resync path instead of silently
stalling once its own guess ran out.

**Verified** by directly reproducing both symptoms against a real
browser session before the fix (an un-nudged countdown reaching zero and
sitting on "is waking up…" indefinitely with no action taken), then
confirming after the fix: the badge transitions straight from "1s" to the
server's real post-wake state with no manual action in between, and a
tab whose visibility is restored after the cooldown has already elapsed
in the background immediately shows "awake" rather than a stale sleeping
state.

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
- README v1 (the definition of good and its grounding), Decision 5's
  verified-against-the-real-deployment findings, and this commit log's
  first citations: [`95f352b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/95f352b4c7dbebb29db0f7fac64eb4c3c1061b70)
- The dedicated concurrency regression test referenced in Decision 4,
  closing the gap between "the architecture guarantees this" and "a test
  proves it": [`01dfeee`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/01dfeee4a98fd820d7130bccba07d45214c919d2)
- Incident 1 (the live-state refresh wasn't one path): [`43016f5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/43016f5a7d7fa59f3834389a51c8f4d8a4ec0ba2)
- Decision 9 (Milo): [`a19b9a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/a19b9a35c8dc240ba5c6b4852cd72c86c31b5e69)
- Incident 2 (activity-expiry resolution unified, resync-on-every-attempt):
  [`11619a6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/11619a676a4a3fb3a166fa490af4157d8bf341e6)
- A verification and hardening pass on the rejection-reason path
  (case-insensitive content-type check, the reason-reading logic extracted
  into one named, auditable function) — done to confirm, not to fix a
  reproduced bug; the symptom it was investigating turned out to be
  Incident 3, found next: [`0b237ca`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/0b237ca2decb2a96d67d804ee267f661397165cf)
- The temporary diagnostic instrumentation that captured Incident 3's
  evidence, deployed deliberately and removed in the very next commit:
  [`f76fee0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/f76fee0ac0ff5bcfd2af30ce387cfce06526def8)
- Incident 3's actual fix (`form.getAttribute("action")`), full removal of
  the diagnostic instrumentation, and its regression test: [`a8d100c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/a8d100c3e3e50c9f2175a6364048ca8f68eb5001)
- Decisions 10, 11 and 12 (age reuses `sessions.createdAt`; wardrobe as
  cosmetic shared state, not an inventory; adventure as one deterministic
  outcome, not a sixth action) landing together — `src/components/age.ts`,
  `src/components/mood.ts` and `src/components/dialogue.ts` are all
  introduced in this commit, alongside `spec/wardrobe.test.ts` and
  `spec/adventure.test.ts`: [`8b2d913`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/8b2d913d013ecaf02fafc9df5a42f964b2edbcba)
- The dedicated-rooms pivot (Decision 13), as the six commits that actually
  carried it out, in sequence: schema for a `rooms` table and a nullable,
  unique `room_id` on `creature` [`1f1d02d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/1f1d02d4749839cd6813ba26917d91130823d5cd);
  room-scoped creature state, per-room SSE broadcasting, and server-side
  care logging [`dcd567f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/dcd567f1b27e29ea48db3ab462929a628111314f);
  the room-aware entry/room-view UI (join by code, host a new room)
  [`386b900`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/386b9004c94d3c6a358841256b552e73113cd2af);
  the full ADR and Decision 13 writeup, plus the crit-10 reflection
  [`415edaf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/415edaf16b292e3279d1422856a8ee615f57ca15);
  every existing spec file rescoped to hosted rooms plus new room
  access-control tests (`spec/rooms.test.ts`) [`4a432f5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/4a432f515561e24a47c42ae39e17a2741b1d1f99);
  and the legacy-room migration backfill fix found in a pre-push
  ship-readiness review, with its own regression test
  (`spec/room-migration-backfill.test.ts`) [`3aa6999`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/3aa69992344171059c1f331a924de2cc8a92b436).
- The durable `log_events` fallback — described in this file's own text as
  Decision 13's follow-up, not a separately numbered decision — with its
  own migration and `spec/log-events.test.ts`/`spec/log-events-migration.test.ts`:
  [`8a368d3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/8a368d3466f27ec1bf373d7fc6cfce7f24abcf26)
- Hashing session ids in logs (`src/lib/log.ts`'s `actorTag()`), so
  `log_events.actor` is a non-reversible tag as CLAUDE.md requires, never
  the raw session id — with `spec/logging.test.ts` asserting the raw id
  never appears in captured output: [`e7fee03`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/e7fee03e06bce63d9cad44e41a7fd94995922550)
- Decision 14 (Milo milestones) — `total_care_actions`, `CARE_MILESTONES`,
  and its migration, with `spec/milestones.test.ts` and
  `spec/milestones-migration.test.ts`: [`a0542c1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/a0542c1e44c44e8df7fea112463f4456f6c206b6)
- Decisions 15 and 16 (five appearances, shared XP/levels, level-gated
  accessories), as the five-commit sequence this file's own `4ac6288`
  entry already describes: schema + migration for `appearance`/`xp` and
  the expanded accessory registry [`1d88529`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/1d8852900ff6e5a7fec886cb6347c7bb46ec99c7);
  XP awarded on every successful action, accessories gated by level and
  appearance (`spec/xp-awards.test.ts`) [`abd303e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/abd303e6100785a8f73e993a1053437522d15f14);
  appearance-switching tests and history now showing which look was active
  (`spec/appearance.test.ts`) [`3ccaab9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/3ccaab9390eed2cc8921baf80ae5cd30b06c5f98);
  the four new creature components (Plip, Bella, Simbaa, Oliver) and the
  room-view appearance picker [`39209ec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/39209ec188ce23f4be1c397056cd1df745f65f14);
  the closing test proving an appearance switch broadcasts the same SSE
  `update` signal as any care action [`27001f4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/27001f41f377f2f927ce886e8d6dc4f8beb148a6);
  and the Decision 15/16 writeup itself, with CLAUDE.md and README updated
  to match [`4ac6288`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/4ac6288c6b844cabb9b5fbab2133585239fa4bff).
- Three character-redesign follow-ups, already filed under Decision 15's
  own text above as exactly what they are — visual-only fixes to
  `src/components/Simbaa.astro`/`Milo.astro`, no schema, mechanics, or
  architecture change, each verified by rendering before being called
  done: Simbaa redesigned to actually read as a lamb [`4f67e5b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/4f67e5b9d4b41ad3c24ed7d63fd4c262058b8532);
  Simbaa's face enlarged and ears shrunk to match the reference
  [`b1303d1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/b1303d1409f47bb14c90def99dab597508988836);
  Milo redesigned to actually read as a puppy, with a new regression test
  in `spec/wardrobe.test.ts` [`b0b8551`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/b0b855158b1b0920d5d3277ce62d40e52d129c27);
  and a follow-up fixing Milo's sleepy-mood eyes, which still read as a
  filled dark blob even after the puppy redesign [`e782154`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/e7821545437eb5a47ed2458b6d33e94d11bc15eb).
- Decision 17 (contextual care suggestions) — `src/components/
  suggestions.ts` and `spec/care-suggestion.test.ts`: [`e0822c9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/e0822c9dfdfba58c7e2dcda2617cd4fd3d8998ce)
- Decision 18 (the Adventure runner) — `src/components/adventureGame.ts`
  and `AdventureGame.astro` (hand-authored pixel-grid sprites for all five
  appearances, obstacles, parallax environment, collectible stars,
  sequence-level obstacle fairness, pause/resume, auto-pause on
  tab-hidden, and the genuine no-JS fallback), `spec/adventure-game.test.ts`,
  and the six real rendering bugs documented in Decision 18's own text
  above (sprite legibility, an invisible collision pose, a self-starving
  star generator, an invisible sparkle color, a sky gap between the hill
  band and the ground): [`522c7a0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/522c7a05add189d2af9b89b893cbb6172a1c60b9)
- Incident 4 (the sleep countdown was a second, un-resynced clock) —
  `attachActivityCountdown()`'s own resync-on-zero and the
  `visibilitychange` resync in `src/pages/index.astro`, with
  `spec/activity-countdown-resync.test.ts` confirmed to fail against the
  pre-fix source and pass against the fix: [`20dcb15`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-abhayskahlon/commit/20dcb15b5a456c300a41d46336d905ee914b4fe6)
