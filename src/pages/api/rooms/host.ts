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

  return redirect("/", 303);
};
