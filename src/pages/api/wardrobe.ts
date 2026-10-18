import type { APIRoute } from "astro";
import { isAccessoryOption } from "../../lib/creature";
import { performWardrobeChange, type WardrobeSlot } from "../../lib/db";
import { getOrCreateSession } from "../../lib/session";

function isWardrobeSlot(value: string): value is WardrobeSlot {
  return value === "hat" || value === "neckwear" || value === "glasses";
}

// Same shape as api/actions.ts: validate server-side (never trust the form
// to only ever submit a known value), attribute to whoever's cookie sent
// it, apply transactionally, redirect back to re-render from the database.
// An unknown slot or an id outside ANY slot's fixed vocabulary is rejected
// here (400), the same way an unknown action name is in api/actions.ts —
// but whether a *known* id is currently equippable (its unlock level, its
// appearance compatibility — PROCESS.md, Decision 16) depends on the
// room's live state, so that check happens inside performWardrobeChange's
// transaction (src/lib/db.ts), not here, and surfaces as a 409 with the
// real reason, the same shape api/actions.ts already uses for a rejected
// care action.
//
// Takes exactly ONE slot and its new value, never a full {hat, neckwear,
// glasses} snapshot — see performWardrobeChange's comment (src/lib/db.ts)
// for the real lost-update bug that shape caused and why this one doesn't.
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
  if (!isAccessoryOption(slot, value)) {
    return new Response("unknown wardrobe option", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  const outcome = performWardrobeChange(slot, value, session, session.roomId);
  if ("reason" in outcome) {
    return new Response(outcome.reason, { status: 409 });
  }

  // "/?enter=1", not "/" — see api/actions.ts's comment: the entry page is
  // now the default for a bare GET /, so every "go back to my room"
  // redirect has to say so explicitly.
  return redirect("/?enter=1", 303);
};
