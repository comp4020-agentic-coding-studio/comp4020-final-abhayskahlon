# COMMONS — project rules

A single shared digital creature, cared for collectively by everyone
currently using the same room. Since the rooms pivot (`ADR 0002,
docs/adr/0002-multi-room-identity-and-access-control.md`), "the room" is an
explicit, chosen scope — a visitor joins one by code or hosts a new one —
rather than the whole deployment; within a room, nothing changed: one
creature, shared, not one per user. The central design question — what
happens when responsibility for one persistent being is shared across
several people — and the project's current account of its stack, agent
workflow and real bugs found via human playtesting live in `PROCESS.md`;
the deeper decision-by-decision history behind today's shape lives in the
ADRs under `docs/adr/` and in git history (each commit message explains
its own reasoning). Read PROCESS.md before changing the schema, the action
rules, the room/identity model, or the real-time mechanism; these rules
summarise the current state for the agent, not replace it.

The room's one shared creature can look like one of five fixed, authored
appearances — Milo (the default), Plip, Bella, Simbaa, or Oliver
(`src/components/{Milo,Plip,Bella,Simbaa,Oliver}.astro`, dispatched through
`CreatureDisplay.astro`) — stored in `creature.appearance` and switched via
`/api/appearance`. This is **not** a naming feature: a visitor picks one of
exactly five server-validated, pre-drawn looks, the same shared, cosmetic
mechanism `hat`/`neckwear`/`glasses` already use — never free text, never a
per-visitor choice, never a second creature. Every visitor in the room sees
the same appearance, and switching it never touches stats, xp, milestones,
or history. Don't add a free-text naming system; don't add a sixth
appearance without updating `APPEARANCES`/`APPEARANCE_LABELS`
(`src/lib/creature.ts`) and giving it its own component following the same
pattern as the other five.

## The database is the only source of truth

- SQLite (via Drizzle, `src/lib/db.ts`) holds the entire persistent state:
  `rooms`, `creature` (one row **per room**, `roomId` unique — including
  `appearance` and `xp`, still exactly one row), `sessions`
  (each with a `roomId` — null until a visitor joins or hosts),
  `care_events` (each row's `roomId` AND `appearance` captured at action
  time, independent of the session's *current* room or the room's *current*
  appearance), and `log_events` (a bounded, durable record of every care
  action and room event, success and rejection alike — a follow-up to the
  rooms pivot, `ADR 0002`; its `actor` column is always a
  one-way hash of the session id, from `src/lib/log.ts`'s `actorTag()`,
  never the raw id). Every creature read or write is scoped by `roomId`,
  and that `roomId` is always derived from the trusted session cookie
  server-side — never a client-supplied field (`ADR 0002,
  docs/adr/0002-multi-room-identity-and-access-control.md`).
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
  This is what makes concurrent requests deterministic (see `ADR 0001,
  docs/adr/0001-concurrent-care-and-realtime-sync.md`) — don't introduce an
  `await` inside that critical section without re-reading that ADR first.
- An action the current state doesn't allow (e.g. `play` with energy below
  the threshold, `sleep` while already asleep) is rejected with a `4xx`
  response and a reason string — never silently clamped into something
  valid, never coerced, never dropped without a response the caller can see.
  A rejection never creates a `care_events` row and never changes stats or
  `last_actor_session_id`. The one narrow exception, found via playtesting:
  `resolveAndSync()` may still write `activity`/
  `activity_until` during a rejected action's validation, but only to
  correct a sleep cooldown that has already, unconditionally expired —
  that's housekeeping matching what the very next read would do regardless,
  never the rejected action's own effect.
- The client never invents, guesses, or reconstructs a rejection reason:
  `readRejectionReason()` in `src/pages/index.astro` only ever shows
  exactly what `/api/actions` sent, and refuses to render a response whose
  content-type is HTML (a real bug found via playtesting — see PROCESS.md)
  rather than ever display raw markup as if it were a reason.
- All four stats always stay inside `[0, 100]`. `health`/condition is never
  stored or mutated directly — it is computed from the other four on every
  read. Don't add a `health` column or a transition rule that writes to it.

## Exactly five actions, exactly four stats

- `feed`, `play`, `walk`, `clean`, `sleep` — no more. Each (other than
  `clean`) both gives and costs something, deliberately, so one visitor's
  action changes what the next visitor should reasonably do. Check
  `applyAction` in `src/lib/creature.ts` for the exact effect/threshold
  table before changing any of it.
  `adventure` is deliberately not one of the five —
  its own route, its own validator, never folded into `ACTIONS` — and
  gaining a playable pixel-art interaction (the Adventure runner) didn't
  change that; the server-side contract it ends in is exactly the same
  deterministic mutation it always was.
- `hunger`, `energy`, `happiness`, `cleanliness` — no more. All four run in
  the same direction: **higher is always better**. `hunger` means how fed
  the creature is, not how hungry — the UI labels it "Fullness" for exactly
  this reason; don't flip the convention in one place without flipping it
  everywhere (schema comment, creature.ts, UI copy all assume it).

## A second, additive shared progress track — XP and levels

- `creature.xp` (cumulative, never decremented) and a **derived, never
  stored** level 1–5 (`getProgression()`, `src/lib/creature.ts`) are a
  second, independent progress axis alongside the room's lifetime
  milestone total (`total_care_actions`) — not a replacement for it, and
  not merged with it. Don't add a `level` column; compute it from `xp`
  every time, the same "derive it, never store it" rule `health` already
  follows.
- Awarded only for a genuinely successful `feed`/`play`/`walk`/`clean`/
  `sleep`/`adventure` (`XP_PER_ACTION`, a flat amount — never varied per
  action), inside the same transaction that increments
  `total_care_actions`. Never for a rejection, never for a wardrobe or
  appearance change.
- This is still room-level and unranked, same as every other shared field
  here: `xp` is never joined against `sessions`, never shown per-visitor,
  never a leaderboard — don't change that.
- Accessories (`ACCESSORIES` in `src/lib/creature.ts`) are gated by the
  room's current level and, for a few items, by its current appearance.
  There's no separate "unlocked" table: availability is always a pure
  function of `(level, appearance)` checked against that static registry.
  `performWardrobeChange` (`src/lib/db.ts`) validates both, inside its own
  transaction, and rejects with a `409` + reason the same way a rejected
  care action does — don't move that check back to static, pre-DB-read
  validation in `api/wardrobe.ts`; it needs the room's live state.

## Real-time is SSE, and the database stays authoritative through it

- `src/lib/sse.ts` broadcasts to open `/api/events` connections after a
  mutation commits — on success only; a rejection never reaches
  `broadcastUpdate()`. Since the rooms pivot, broadcasting is **per room**
  (`broadcastUpdate(roomId)`, a `Map<roomId, Set<client>>`, not one flat
  `Set`): an update in one room must never reach a client connected to a
  different room, since the mere existence of an event is itself a signal
  about that room. The broadcast payload is a bare signal (`{}`), never a
  copy of state — a client that reconnects, or that gets this signal,
  always re-fetches current state from `GET /`, because nothing in the SSE
  payload isn't already in SQLite.
- `refreshLiveState()` in `src/pages/index.astro` is the one place that
  re-fetch happens, and it always swaps the *complete* `#live-state` (stats,
  condition, activity, last action, and history together) — never a
  subset. It runs after an SSE `update` event for every other open tab,
  and — after a real bug found via playtesting where the actor's own tab
  could silently go stale — after the actor's own action too,
  on **both** success and rejection: a rejection can mean this tab's own
  view was stale (it missed an event), and refreshing is what makes that
  visible instead of leaving a stale badge next to a reason that
  contradicts it. Don't special-case the actor's own tab back to a
  different mechanism (a full `location.reload()`, a partial DOM patch) —
  that divergence between "my own action" and "someone else's action,
  seen live" is exactly what caused that bug.
- Don't add polling or WebSockets alongside this without a new decision
  record explaining why SSE stopped being sufficient (`ADR 0001,
  docs/adr/0001-concurrent-care-and-realtime-sync.md`).

## Never read `form.action` — use `getAttribute("action")`

- Every action form carries a hidden input `name="action"`. Per the
  HTML/DOM named-property algorithm, that control **shadows**
  `HTMLFormElement`'s own built-in `action` property in real browsers:
  `form.action` resolves to the input element itself, not the URL string,
  and `fetch(form.action, …)` silently stringifies it to
  `"[object HTMLInputElement]"` — a real production bug (see PROCESS.md
  and commit `a8d100c`), found only by a human clicking a real button,
  never by any scripted test, because every script calls `fetch()` with a
  hand-built URL string and never touches a real DOM form.
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
  deliverable (see "Out of scope" below).
- Since the rooms pivot, a session also carries a `roomId` (null until it joins
  or hosts a room). That value is set in exactly two places —
  `hostRoom()`/`joinRoom()` in `src/lib/db.ts` — and every mutating route
  reads it from the session, never from a client-supplied field. Don't add
  a `roomId` form field, query parameter, or body key to any route that
  mutates creature state; that would reopen exactly the cross-room access
  the server-derived-room design (`docs/adr/0002`) exists to close by
  construction.

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
  localhost (`ADR 0001, docs/adr/0001-concurrent-care-and-realtime-sync.md`,
  "Verified against the real deployment").
- `spec/activity-resolution.test.ts` (its own instance, `SLEEP_COOLDOWN_MS`
  overridden short) proves a real bug's fix holds: once a sleep cooldown
  has genuinely passed, the very next action
  succeeds with no GET in between, and a later rejection names the
  actually-applicable rule (e.g. "too hungry to sleep"), never a
  stale "already asleep".
- `spec/action-form-url.test.ts` guards the `form.action` shadowing bug
  (see "Never read `form.action`" above) — the one spec file here that
  constructs a real DOM form element rather than only calling `fetch()`
  with a hand-built URL string, and the only one that can catch this
  class of bug at all.
- `spec/activity-countdown-resync.test.ts` guards a real bug found via
  playtesting — a static source check, the same kind
  `action-form-url.test.ts` uses, since this is real browser
  `setInterval`/`visibilitychange` timing jsdom doesn't meaningfully
  execute. Asserts the countdown's own `tick()`
  calls `refreshLiveState()` once it reaches zero (so the creature wakes
  itself up without requiring an unrelated action first) and that a
  `visibilitychange` listener resyncs a backgrounded tab on return.
- `spec/activity-countdown.test.ts` guards that same bug's follow-up — the
  countdown trusting the visitor's own, possibly wrong, system clock
  (reported as "19s" shown for an 8-second sleep). Unlike the resync fix
  above, this bug is pure arithmetic once extracted
  (`src/components/activityCountdown.ts`), so it's tested directly and
  numerically rather than only by source pattern: the exact reported
  figure is reproduced against the pre-fix arithmetic before confirming
  the fix corrects it.
- Every spec file above was written to protect a real, previously-reported
  or previously-reasoned-about failure — not added speculatively. Don't add
  a new one without a specific invariant it protects that nothing else
  here already covers.

## Out of scope

No accounts/profiles, chat, voting/likes, maps, push/SMS/email
notifications, realtime infrastructure beyond the single SSE endpoint above,
admin dashboards, machine learning, leaderboards, achievements, shops,
inventories, or AI. See PROCESS.md for the one idea (a non-competitive
"neglect" callout) that was considered and deliberately deferred rather
than rejected outright.

"Multiple creatures" is no longer on this list as a blanket rule — see
`ADR 0002, docs/adr/0002-multi-room-identity-and-access-control.md`. A room
still has exactly one shared creature, no per-user creature, no per-user
ownership; what's allowed is multiple *rooms*, each isolated, each with
its own single creature. Don't read this as license to add a second
creature within one room, a per-user pet, or anything else this list
otherwise still rules out.

"Achievements" and "leaderboards" are, and remain, ruled out only in the
sense of ranking one *visitor* against another. The room-level,
unranked milestone total and the room-level, unranked XP/
level track with its level-gated cosmetics are both the
shared, collective-progress shape this line was never written to forbid —
neither is ever joined against `sessions`, shown per-visitor, or usable to
compare one visitor's contribution to another's. Don't read either as
license to add anything that *does* rank visitors against each other; that
line is still exactly as firm as it always was.
