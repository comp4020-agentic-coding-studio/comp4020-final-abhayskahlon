import type { APIRoute } from "astro";
import { getRoomLogEvents } from "../../../lib/db";
import { getOrCreateSession } from "../../../lib/session";

// Read-only access to the durable log_events table (PROCESS.md, Decision
// 13's log-retention follow-up) — the one place a visitor (or a tutor
// looking over their shoulder) can see this room's own durable event
// record without `flyctl logs` access. JSON, not HTML: this is a data
// endpoint for the crit demo / later assessment to query directly, not a
// rendered page.
//
// The room is ALWAYS session.roomId — read from the trusted, httpOnly
// session cookie, exactly like every mutating route (docs/adr/0002). There
// is no room-id query parameter or any other client-supplied value this
// route accepts: a request cannot ask to read a DIFFERENT room's events by
// changing anything in the request, because there is nothing room-shaped
// in the request for it to change. A session with no room yet gets 403,
// the same as every other room-scoped route.
export const GET: APIRoute = async ({ cookies }) => {
  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  const events = getRoomLogEvents(session.roomId);
  return new Response(JSON.stringify({ roomId: session.roomId, events }), {
    headers: { "content-type": "application/json" },
  });
};
