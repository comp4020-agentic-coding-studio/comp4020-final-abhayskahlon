import type { APIRoute } from "astro";
import { hostRoom } from "../../../lib/db";
import { isValidDisplayName, normalizeDisplayName } from "../../../lib/room";
import { getOrCreateSession } from "../../../lib/session";

// Creates a brand-new room with its own creature and makes this visitor its
// host — attribution only, no extra powers over an ordinary member
// (PROCESS.md, Decision 13). The only client input here is a display name;
// the room code itself is always server-generated (src/lib/room.ts), never
// something a visitor supplies — there's nothing here for a crafted request
// to redirect at another room.
export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const name = String(form.get("name") ?? "");

  if (!isValidDisplayName(name)) {
    return new Response("enter a name first", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  hostRoom(session, normalizeDisplayName(name));

  // "/?enter=1": hosting is itself an explicit, deliberate choice to enter
  // a room (the whole point of the form just submitted) — landing straight
  // on it, not back on the entry page, is the correct result. See
  // src/pages/index.astro's comment on showEntry for why a bare "/" alone
  // would no longer be enough to reach the room view.
  return redirect("/?enter=1", 303);
};
