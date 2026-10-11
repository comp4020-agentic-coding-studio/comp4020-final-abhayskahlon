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

## Out of scope for this deliverable (unchanged from the course's own list)

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, admin dashboards, machine learning — and, specific to this
concept, no leaderboards, achievements, shops, inventories, multiple
creatures, or AI. The neglect callout (Decision 3) is the one idea considered
and explicitly deferred rather than rejected outright.

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
