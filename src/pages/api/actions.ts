import type { APIRoute } from "astro";
import { ACTIONS, type ActionName } from "../../lib/creature";
import { performAction } from "../../lib/db";

function isActionName(value: string): value is ActionName {
  return (ACTIONS as readonly string[]).includes(value);
}

// The write half of the care loop: validate the action name server-side
// (never trust the form to only ever submit one of the five buttons),
// apply it transactionally against SQLite, and redirect back to re-render
// from the database — the same POST + 303 shape the course's other starter
// uses, so the core loop needs no client JavaScript. A rejected action
// (e.g. not enough energy) is a 409: understood, but not applicable right
// now — never a silent no-op and never coerced into something valid.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (!isActionName(action)) {
    return new Response("unknown action", { status: 400 });
  }

  const outcome = performAction(action);
  if ("reason" in outcome) {
    return new Response(outcome.reason, { status: 409 });
  }

  return redirect("/", 303);
};
