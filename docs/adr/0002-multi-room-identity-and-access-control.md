# ADR 0002: Dedicated rooms, each with its own creature — identity and access control

**Status:** Accepted — Week 10/11 (crit 10), 2026-10-18.

## Context

Crit 10's spec requires the deployed app to be genuinely multi-user: two or
more people, each in their own browser, act on shared state, and the app
tells them apart; what each person may see and change is checked on the
server and that decision is written down; the app logs who did what,
server-side, durably.

COMMONS already told visitors apart (an unauthenticated cookie session —
PROCESS.md, Decision 7) and already checked permissions server-side (every
mutation reads its actor from the trusted cookie, never a client-supplied
id). What it did not have was any notion of a *group*: every visitor, on
every device, anywhere, shared the exact same single creature. The
student's direction for this deliverable goes beyond the bare spec reading:
real dedicated rooms, where a visitor picks a name and either joins an
existing room by code or hosts a new one, and only the people in that room
share that room's own Milo.

This is a genuine pivot, not an incremental feature. PROCESS.md's Decision
1 originally framed COMMONS as "one persistent being, not one per user,"
and CLAUDE.md's out-of-scope list named "multiple creatures" explicitly.
Both were written when "the room" meant the whole deployment — this
decision keeps everything those rules were actually protecting (one shared
creature per group, visible unranked collective care, no per-user pet) and
makes the group itself an explicit, chosen scope instead of an implicit,
fixed one. See PROCESS.md, Decision 13, for the full accounting of what
changed and why it isn't a quiet contradiction.

## Decision

1. **A room is the unit of sharing, not the deployment.** A new `rooms`
   table (`src/lib/schema.ts`) holds one row per room, keyed by the room's
   own code. `creature.roomId` is **unique** — a room has exactly one
   creature, created the moment it's hosted and never recreated.
   `sessions.roomId` and `careEvents.roomId` scope session membership and
   history to a room the same way.

2. **A room code is the only credential to join, and it's never trusted
   without a server-side lookup.** Codes are 6 characters, uppercase,
   drawn from an alphabet that excludes visually ambiguous characters
   (`0/O`, `1/I/L` — `src/lib/room.ts`), always server-generated when
   hosting, never chosen by the client. Joining validates the code against
   the database inside the same transaction that moves the session into
   the room (`src/lib/db.ts`'s `joinRoom`) — a well-formed but non-existent
   code is rejected with a real 404 and a reason, the same "never silently
   absorbed" standard CLAUDE.md already holds every rejected action to.

3. **The room a request acts on is always derived from the trusted session
   cookie, never from anything the client supplies.** Every mutating route
   (`/api/actions`, `/api/wardrobe`, `/api/adventure`, `/api/events`) reads
   `session.roomId` — looked up via `getOrCreateSession`'s httpOnly cookie
   — and uses that value, and only that value, as the room to read or
   write. There is no `roomId` form field, query parameter, or request body
   key anywhere in these routes for a crafted request to supply. This is
   the entire access-control mechanism for "a visitor must not touch
   another room's data by changing a URL, form field, or request body": it
   isn't a check that could be forgotten on one route, because there is
   structurally nothing room-shaped in the request for such a route to
   trust in the first place. The only two routes that take any room-shaped
   client input at all are `join` (a code, validated against the database
   per point 2) and `host` (takes no room input — the code is always
   generated, never supplied).

4. **A host has attribution, not authority.** `rooms.hostSessionId` records
   who created the room, shown as "Hosted by X" — exactly the same
   attribution-only pattern `creature.lastActorSessionId` already uses
   elsewhere. A host can feed/play/walk/clean/sleep/dress/adventure
   identically to any other member of the room; nothing in `applyAction`,
   `performWardrobeChange`, or `performAdventure` ever branches on whether
   the acting session is the room's host. This was a deliberate choice, not
   an oversight: COMMONS' whole premise (README.md, "what good means here")
   is collective responsibility without hierarchy or competition, and
   giving the room's creator special powers over the same creature everyone
   else cares for would directly contradict that, inside the room, the
   exact way a leaderboard would have contradicted it across the whole
   app.

5. **Joining or hosting always overwrites a session's current room.** A
   session belongs to whichever room it most recently joined or hosted;
   there is no separate "leave" action, and no restriction on moving
   between rooms. A `/?switch=1` link is the one way back to the entry
   experience while already in a room.

6. **Real-time updates are scoped per room.** `src/lib/sse.ts`'s single
   flat client `Set` becomes a `Map<roomId, Set<client>>`;
   `broadcastUpdate(roomId)` only ever iterates that room's own open
   connections. This is the one place a naive room feature could silently
   leak information across rooms even though the broadcast payload itself
   carries no state (PROCESS.md, Decision 5) — the *existence* of an event
   is itself a signal ("something just changed in this room right now"),
   and a visitor in room B has no business receiving that signal about
   room A. `spec/realtime.test.ts` is extended with exactly this
   cross-room isolation case.

7. **The legacy single creature migrates into a fixed default room, not a
   reset.** The migration that adds these columns (`drizzle/0003_*.sql`)
   backfills any pre-existing creature/session/care-event rows into one
   room, `id = "COMMONS"`. `host_session_id` is left `null` — the room
   predates rooms entirely, so nobody actually hosted it, and attributing
   it to whoever most recently acted would misrepresent a visitor as its
   creator. `created_at` is backfilled from the earliest recorded session
   (`MIN(sessions.created_at)`), not the creature row's own `updated_at`
   (overwritten by every mutation, which would have silently reset Milo's
   displayed age to "new" at migration time). On a fresh database every
   backfill statement matches zero rows — a correct no-op, not a forced
   room.

8. **Server-side logging, scoped by room and a non-reversible actor tag.**
   `src/lib/log.ts` writes one structured JSON line to stdout for every
   room host/join/rejected-join and every care action's outcome (success
   *and* rejection), scoped by room and session. This is Fly's own log
   collector, read live via `mise exec -- flyctl logs -a <repo>` during the
   crit's own demo — not a new database table — because a rejection's
   attribution (who tried what, and why it didn't go through) is the one
   thing `care_events` can never show, since a rejection is never written
   there (CLAUDE.md). Each line's `actor` field is a one-way SHA-256 digest
   of the session id, never the raw id — an earlier draft logged the raw
   value, which IS the session's entire bearer credential (Decision 7, no
   password layer), making every log line a potential session-hijack
   vector for anyone who could read it; found and fixed in ship-readiness
   review (`spec/logging.test.ts` proves it directly against a real
   server's captured stdout). **Retention is documented by Fly as roughly
   7 days, but was not independently confirmed for this specific org/app**
   — see PROCESS.md, Decision 13, for the full accounting and why stdout
   logs alone should not be relied on past the crit week itself.

## Alternatives considered

- **Cosmetic-only rooms (a shared "who's in my room" grouping, but all
  rooms still read/write one global creature).** Rejected: it can't
  actually satisfy the spec's "a visitor must not access or mutate another
  room's data" requirement, because there would be no data to isolate in
  the first place — everyone would still be mutating the same row no
  matter which "room" they claimed to be in. This would have been
  theater, not access control.

- **A client-supplied room id on each mutating request (e.g. a hidden
  `roomId` form field, validated against session membership server-side).**
  Rejected in favour of deriving the room from the cookie alone: a
  client-supplied field, even one checked against membership, is one more
  thing every route has to remember to validate correctly, and a missed or
  loosened check on any single route silently reopens cross-room access.
  Deriving the room from the trusted session server-side, with no
  room-shaped field anywhere in the request, removes that entire class of
  mistake by construction rather than by discipline.

- **Host moderation powers (rename the room, remove a member).** Rejected
  for this deliverable: it adds real surface area (new mutations, new
  authorization branches, new rejection paths, new tests) that nothing in
  the brief or the spec actually requires, and it reintroduces exactly the
  kind of per-person asymmetry README.md's definition of good argues
  against. Left as a possible future idea, not built.

- **A session locked to its first room forever (no switching).** Rejected:
  it has no recovery path for a visitor who mistypes a room code or wants
  to visit a different pod's room, short of clearing cookies — a worse
  visitor experience for no real security benefit, since nothing about
  "can only ever join one room" makes any single room's data more
  protected.

## Trade-offs and consequences

- **A session's room membership is still only as trustworthy as its
  cookie.** This is not a new trust boundary introduced by rooms — it's
  the same one PROCESS.md, Decision 7 already accepted for identity itself
  (an httpOnly cookie, no password, no account). Rooms inherit it
  unchanged: whoever holds a session's cookie can act as that session in
  whichever room it currently belongs to, exactly as whoever held a
  cookie could always act as that session on the single shared creature
  before rooms existed.
- **A room code, once known, lets anyone join.** This is the explicit,
  intended design — "join code" means exactly this, the same way a
  meeting link or a shared document link works. There is no invite list,
  no approval step, no capacity limit; the code itself is the access
  control, sized (6 characters from a 31-character alphabet) to resist
  casual guessing without being a password.
- **Rooms are never deleted or garbage-collected.** An abandoned room's
  creature and history simply sit in the database indefinitely, the same
  as `care_events`' capped-but-persistent history always has. Out of scope
  for this deliverable; worth a future decision if room count becomes a
  real operational concern.
- **This still depends on the one-machine/one-volume shape** PROCESS.md,
  Decision 4 already names as this app's concurrency foundation. Nothing
  about rooms changes that dependency — every room's mutations still run
  through the same single synchronous `better-sqlite3` connection, just
  filtered to a different `room_id` per call.

## Evidence

- `spec/rooms.test.ts` — hosting assigns a unique, valid-format code and
  host attribution; joining an existing code succeeds, an unknown code is
  rejected with a reason, an invalid name is rejected; two sessions in the
  same room see each other's actions and history; a session acting in room
  A never affects room B's creature or history; care-event attribution
  survives a session later switching rooms; room membership persists
  across a reload with no new `Set-Cookie`; switching rooms overwrites
  membership.
- `spec/realtime.test.ts` — extended with the cross-room broadcast
  isolation case: an update in room A is never delivered to a client
  connected to room B.
- Every other existing spec file (`concurrency`, `adventure`, `wardrobe`,
  `persistence`, `activity-resolution`, `sessions`, `action-form-url`) was
  updated only to host (or join) a room as part of its setup — the
  arithmetic and timing invariants they already proved are otherwise
  unchanged, just scoped to the hosted room instead of a global singleton.
- Manual verification against a freshly built server with a throwaway
  database (see the commit that landed the entry experience): hosting,
  joining, cross-room isolation, an unknown-code rejection, a no-room
  session's `/api/events` 403, and a rejected care action's reason and log
  line, all checked directly over HTTP before any automated test existed
  for them.
