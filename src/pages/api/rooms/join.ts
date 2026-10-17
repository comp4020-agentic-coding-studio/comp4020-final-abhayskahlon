import type { APIRoute } from "astro";
import { joinRoom } from "../../../lib/db";
import { isValidDisplayName, isValidRoomCodeFormat, normalizeDisplayName, normalizeRoomCode } from "../../../lib/room";
import { getOrCreateSession } from "../../../lib/session";

// Moves this visitor into an existing room by code. Two separate rejection
// reasons, both server-side, both real: a malformed code (never even
// queries the database — src/lib/room.ts's format check) versus a
// well-formed code that doesn't match any room (src/lib/db.ts's joinRoom,
// which is the one point of contact with what rooms actually exist). This
// is the entire access-control surface for joining: the room code is the
// only credential, exactly as a join code is meant to work, and it's
// checked against the database every time — never trusted just because it
// looks well-formed.
export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  const codeRaw = String(form.get("roomCode") ?? "");

  if (!isValidDisplayName(name)) {
    return new Response("enter a name first", { status: 400 });
  }

  const code = normalizeRoomCode(codeRaw);
  if (!isValidRoomCodeFormat(code)) {
    return new Response("that doesn't look like a room code", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  const outcome = joinRoom(session, normalizeDisplayName(name), code);
  if ("reason" in outcome) {
    return new Response(outcome.reason, { status: 404 });
  }

  return redirect("/", 303);
};
