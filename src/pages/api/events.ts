import type { APIRoute } from "astro";
import { addClient, removeClient } from "../../lib/sse";
import { getOrCreateSession } from "../../lib/session";

const encoder = new TextEncoder();

// One held-open connection per client, added to the in-memory broadcast set
// for the session's own room (src/lib/sse.ts) — never any other room's.
// Nothing here reads or writes creature state — this route only relays a
// signal that src/lib/db.ts emits after a mutation commits; the database
// stays the only source of truth (see CLAUDE.md, PROCESS.md Decision 5).
//
// The room is derived from the trusted session cookie, exactly like every
// mutating route — never from a query string or any other client-supplied
// value (docs/adr/0002). A session with no room yet (never got past the
// entry page) has nothing to subscribe to; 403 closes that off rather than
// silently opening a connection that would never receive anything.
export const GET: APIRoute = async ({ request, cookies }) => {
  const session = getOrCreateSession(cookies);
  if (!session.roomId) {
    return new Response("join or host a room first", { status: 403 });
  }
  const roomId = session.roomId;

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      addClient(controller, roomId);
      // A short reconnect hint, and something written immediately: a proxy
      // holding the response open with nothing sent yet looks, from the
      // client's side, identical to one that's silently buffering
      // everything — writing right away is what makes that distinguishable
      // when checking the real deployment (see PROCESS.md, Decision 5).
      controller.enqueue(encoder.encode("retry: 2000\n: connected\n\n"));
    },
    cancel() {
      if (controllerRef) removeClient(controllerRef, roomId);
    },
  });

  request.signal.addEventListener("abort", () => {
    if (controllerRef) removeClient(controllerRef, roomId);
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // A hint for nginx-style proxies (including Fly's) to not buffer this
      // response. Harmless where it's not understood — but never assumed to
      // work until checked against the real deployment.
      "x-accel-buffering": "no",
    },
  });
};
