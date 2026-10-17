import type { APIRoute } from "astro";
import { performAdventure } from "../../lib/db";
import { getOrCreateSession } from "../../lib/session";

// Same shape as api/actions.ts (attribute, apply transactionally, 303 on
// success / 409 with a reason on rejection) — adventure is a shared
// activity, not a sixth care action, so it gets its own route rather than
// being folded into /api/actions' five-item ACTIONS vocabulary.
//
// The room is always session.roomId, same as api/actions.ts — never a
// client-supplied field (docs/adr/0002).
export const POST: APIRoute = async ({ redirect, cookies }) => {
  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  const outcome = performAdventure(session, session.roomId);
  if ("reason" in outcome) {
    return new Response(outcome.reason, { status: 409 });
  }

  return redirect("/", 303);
};
