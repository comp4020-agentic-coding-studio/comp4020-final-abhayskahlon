// Durable, server-side, structured logging of "who did what" — the one
// concrete gap this crit's spec names directly: logging that outlives the
// crit, read from `mise exec -- flyctl logs -a <repo>` while narrating a
// live two-profile demo. Deliberately NOT a database table: Fly's own log
// retention is what "outlives the crit" means here, and the database
// already has its own durable, attributed record of successful actions
// (`care_events` — see PROCESS.md, Decision 6) — this is a second, line-
// oriented channel for a human (or their tutor) to read live, not a second
// source of truth for application state. A rejection is never written to
// `care_events` (CLAUDE.md), but it IS logged here, on purpose: "which
// session tried what, and why it didn't go through" is exactly the kind of
// thing the crit's two-profile demo needs to narrate, and it's the one
// case the database's own history can never show.
//
// One line per call, to stdout, as JSON — easy to grep, easy to read raw,
// and exactly what Fly's log collector expects (plain stdout/stderr lines).
export interface CareLogEvent {
  roomId: string | null;
  sessionId: string;
  sessionLabel: string;
  action: string;
  outcome: "success" | "rejected";
  reason?: string;
}

export function logCareEvent(event: CareLogEvent): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      type: "care_event",
      ...event,
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
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ...event,
    }),
  );
}
