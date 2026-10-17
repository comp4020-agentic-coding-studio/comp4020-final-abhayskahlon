import type { APIRoute } from "astro";
import { isHatOption, isNeckwearOption } from "../../lib/creature";
import { performWardrobeChange, type WardrobeSlot } from "../../lib/db";
import { getOrCreateSession } from "../../lib/session";

function isWardrobeSlot(value: string): value is WardrobeSlot {
  return value === "hat" || value === "neckwear";
}

// Same shape as api/actions.ts: validate server-side (never trust the form
// to only ever submit a known value), attribute to whoever's cookie sent
// it, apply transactionally, redirect back to re-render from the database.
// Unlike actions.ts there is no activity-based rejection here — a wardrobe
// change touches no stat and no activity rule — but an unknown slot or an
// option outside that slot's fixed vocabulary is still rejected, the same
// way an unknown action name is in api/actions.ts.
//
// Takes exactly ONE slot and its new value, never a full {hat, neckwear}
// snapshot — see performWardrobeChange's comment (src/lib/db.ts) for the
// real lost-update bug that shape caused and why this one doesn't.
//
// The room is always session.roomId, same as api/actions.ts — never a
// client-supplied field (docs/adr/0002).
export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const slot = String(form.get("slot") ?? "");
  const valueRaw = form.get("value");
  const value = valueRaw === null || valueRaw === "" ? null : String(valueRaw);

  if (!isWardrobeSlot(slot)) {
    return new Response("unknown wardrobe slot", { status: 400 });
  }
  const valid = slot === "hat" ? isHatOption(value) : isNeckwearOption(value);
  if (!valid) {
    return new Response("unknown wardrobe option", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  performWardrobeChange(slot, value, session, session.roomId);

  return redirect("/", 303);
};
