import type { APIRoute } from "astro";
import { isAppearanceId } from "../../lib/creature";
import { performAppearanceChange } from "../../lib/db";
import { getOrCreateSession } from "../../lib/session";

// Switching which of the five fixed, authored looks the room's one shared
// creature renders as — PROCESS.md, Decision 15. Modelled directly on
// api/wardrobe.ts: validate the posted value server-side (never trust the
// form), attribute to whoever's cookie sent it, apply transactionally,
// redirect back to re-render from the database. Never rejects beyond an
// unknown value (400) or no room yet (403) — there's no level gate or
// stat rule on appearance itself, only on accessories (api/wardrobe.ts).
//
// The room is always session.roomId, same as every other mutating route —
// never a client-supplied field (docs/adr/0002).
export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const value = String(form.get("appearance") ?? "");

  if (!isAppearanceId(value)) {
    return new Response("unknown appearance", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  performAppearanceChange(session, session.roomId, value);

  return redirect("/?enter=1", 303);
};
