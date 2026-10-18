import type { APIRoute } from "astro";
import { ACTIONS, type ActionName } from "../../lib/creature";
import { performAction } from "../../lib/db";
import { getOrCreateSession } from "../../lib/session";

function isActionName(value: string): value is ActionName {
  return (ACTIONS as readonly string[]).includes(value);
}

// The write half of the care loop: validate the action name server-side
// (never trust the form to only ever submit one of the five buttons),
// attribute it to whoever's cookie sent it, apply it transactionally
// against SQLite, and redirect back to re-render from the database — the
// same POST + 303 shape the course's other starter uses, so the core loop
// needs no client JavaScript. A rejected action (e.g. not enough energy) is
// a 409: understood, but not applicable right now — never a silent no-op,
// never coerced into something valid, and never recorded in the care
// history (performAction only inserts a care_events row on success).
//
// Redirects to "/?enter=1", not "/": since the entry page became the
// default for a bare GET / (src/pages/index.astro), every internal link
// that means "go back to my room" has to say so explicitly. Without this,
// every single successful action would bounce the visitor back to the
// entry screen instead of back to Milo — not just the "which page greets
// a fresh visit" behaviour this was meant to change.
//
// The room this action applies to is ALWAYS session.roomId — read from the
// trusted, httpOnly session cookie, never from the request body or any
// other client-supplied value (docs/adr/0002-multi-room-identity-and-
// access-control.md). There is no "roomId" form field for a client to set:
// a visitor literally cannot ask this route to act on a room other than
// their own. A session with no room yet gets 403, not a crash or a silent
// no-op — the normal page flow never renders these forms before a room is
// joined, so this only matters for a direct request.
export const POST: APIRoute = async ({ request, redirect, cookies }) => {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (!isActionName(action)) {
    return new Response("unknown action", { status: 400 });
  }

  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }

  const outcome = performAction(action, session, session.roomId);
  if ("reason" in outcome) {
    return new Response(outcome.reason, { status: 409 });
  }

  return redirect("/?enter=1", 303);
};
