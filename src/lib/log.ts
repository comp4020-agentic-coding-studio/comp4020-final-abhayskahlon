import { createHash } from "node:crypto";

// Server-side, structured logging of "who did what" — the one concrete gap
// this crit's spec names directly, read live from
// `mise exec -- flyctl logs -a <repo>` while narrating a two-profile demo.
// Deliberately NOT a database table: this is a second, line-oriented
// channel for a human (or their tutor) to read live, not a second source
// of truth for application state — the database already has its own
// durable, attributed record of successful actions (`care_events` — see
// PROCESS.md, Decision 6). A rejection is never written to `care_events`
// (CLAUDE.md), but it IS logged here, on purpose: "which session tried
// what, and why it didn't go through" is exactly the kind of thing the
// crit's two-profile demo needs to narrate, and it's the one case the
// database's own history can never show.
//
// Whether this stdout channel itself "outlives the crit" depends entirely
// on Fly's own log retention, which is NOT something this module controls
// or can guarantee — see PROCESS.md, Decision 13's log-retention note for
// what's actually confirmed (documented, not independently verified for
// this org) versus assumed. Don't treat a log line here as durable beyond
// the crit week itself; `care_events` is the actually-durable record for
// successful actions, for as long as this app's volume exists.
//
// One line per call, to stdout, as JSON — easy to grep, easy to read raw,
// and exactly what Fly's log collector expects (plain stdout/stderr lines).

// The session cookie value (src/lib/session.ts's `commons_session`) IS the
// session's entire bearer credential — whoever holds it can act as that
// session, in whatever room it currently belongs to, with no password
// layer (PROCESS.md, Decision 7). Logging that raw value would hand
// anyone who can read these logs (course staff via `flyctl logs`, or
// anyone else with log/Fly access) a session-hijack credential for free —
// found and fixed during ship-readiness review, before this ever shipped.
// `actorTag()` is the fix: a stable, NON-REVERSIBLE identifier derived
// from the session id via a one-way hash, so the SAME session always logs
// the SAME short tag (still useful for "these five lines are the same
// actor" and for a tutor cross-checking a log line against a specific
// browser's actions during the crit demo), but the tag alone can never be
// turned back into the cookie value that would let someone impersonate
// that session. No new secret to manage: this is a plain one-way digest,
// not an HMAC, because there's nothing here that needs to resist a
// deliberate attacker reversing a KNOWN session id back to its tag (that
// direction is trivial and fine — the tag isn't meant to be unguessable,
// only to not leak the credential itself); it only needs to resist the
// credential being recovered FROM the tag, which SHA-256 already does.
// Truncated to 10 hex characters: short enough to read comfortably in a
// log line and still over a trillion possible values, far more than this
// app will ever have concurrent sessions for — a collision between two
// real sessions attributing one's actions to the other is not a realistic
// risk at that scale, and even if it somehow occurred, it would only ever
// affect which log LINE a tag is grouped with, never any actual data in
// SQLite (care_events still carries the real, unhashed session_id for
// genuine attribution — only this stdout channel is affected).
// Exported so src/lib/db.ts's durable log_events table (PROCESS.md,
// Decision 13's log-retention follow-up) can tag its own rows the exact
// same way, rather than a second hand-written copy of this logic that
// could drift from this one — there is exactly one definition of "how a
// session id becomes a non-reversible actor tag" in this codebase.
export function actorTag(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

export interface CareLogEvent {
  roomId: string | null;
  sessionId: string;
  sessionLabel: string;
  action: string;
  outcome: "success" | "rejected";
  reason?: string;
}

export function logCareEvent(event: CareLogEvent): void {
  const { sessionId, ...rest } = event;
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      type: "care_event",
      actor: actorTag(sessionId),
      ...rest,
    }),
  );
}

export interface RoomLogEvent {
  // null for a rejected join whose code didn't resolve to any room — there
  // is no real room to attribute the attempt to, only the (possibly
  // malformed) code the visitor typed, carried separately below.
  roomId: string | null;
  sessionId: string;
  sessionLabel: string;
  type: "room_hosted" | "room_joined" | "room_join_rejected";
  attemptedCode?: string;
  reason?: string;
}

export function logRoomEvent(event: RoomLogEvent): void {
  const { sessionId, ...rest } = event;
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      actor: actorTag(sessionId),
      ...rest,
    }),
  );
}
