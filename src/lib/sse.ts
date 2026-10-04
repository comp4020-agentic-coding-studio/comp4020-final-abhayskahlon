// In-memory broadcast to every open `/api/events` connection. This is NOT a
// source of truth (see CLAUDE.md) — if the process restarts, this set is
// simply empty, and nothing is lost, because nothing it ever held was
// authoritative. It only decides who currently gets told "something
// changed"; SQLite is still the only place "what changed" actually lives.
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

export function addClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
  clients.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
  clients.delete(controller);
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, chunk: string): void {
  try {
    controller.enqueue(encoder.encode(chunk));
  } catch {
    // the connection is already gone; stop tracking it rather than throw
    // again on the next broadcast or heartbeat
    clients.delete(controller);
  }
}

// Called once a mutation has actually COMMITTED (src/lib/db.ts only calls
// this from performAction's success path — never for a rejection). The
// payload is deliberately NOT the new creature state: it's a bare signal
// telling every other open tab to go re-fetch the authoritative page
// itself. If this ever started carrying state fields, a client could start
// rendering from the event alone and silently drift from SQLite — see
// PROCESS.md, Decision 5.
export function broadcastUpdate(): void {
  const chunk = "event: update\ndata: {}\n\n";
  for (const controller of clients) send(controller, chunk);
}

// A periodic comment line — ignored by EventSource's message handling, so
// it never looks like an "update" — just so an idle connection still sends
// *something* regularly. This is what lets a half-dead connection get
// noticed (enqueue throws, and it's dropped from `clients`), and it's the
// first thing to check against the real deployment: if a proxy buffers
// this response, neither the heartbeat nor a real update arrives at the
// client until the buffer flushes for some unrelated reason.
const HEARTBEAT_MS = 15000;
const heartbeatTimer = setInterval(() => {
  for (const controller of clients) send(controller, ": heartbeat\n\n");
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();
