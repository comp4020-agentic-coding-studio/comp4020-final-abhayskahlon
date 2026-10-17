// In-memory broadcast to every open `/api/events` connection, scoped per
// room (PROCESS.md, Decision 13). This is NOT a source of truth (see
// CLAUDE.md) — if the process restarts, every room's set here is simply
// empty, and nothing is lost, because nothing it ever held was
// authoritative. It only decides who currently gets told "something
// changed" IN THEIR OWN ROOM; SQLite is still the only place "what changed"
// actually lives.
//
// Keyed by room id rather than one flat Set: an update in one room must
// never reach a client connected to a different room (docs/adr/0002 —
// cross-room broadcast leakage would hand one room's visitors a live
// signal about another room's private state, even though the signal
// itself carries no data). A Map of per-room Sets, rather than tagging each
// controller with its room and filtering a single flat Set on every
// broadcast, keeps a broadcast O(room's own client count) instead of
// O(every connected client across every room).
const roomClients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();

export function addClient(controller: ReadableStreamDefaultController<Uint8Array>, roomId: string): void {
  let set = roomClients.get(roomId);
  if (!set) {
    set = new Set();
    roomClients.set(roomId, set);
  }
  set.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController<Uint8Array>, roomId: string): void {
  const set = roomClients.get(roomId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) roomClients.delete(roomId); // don't let empty rooms' sets accumulate forever
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, chunk: string, roomId: string): void {
  try {
    controller.enqueue(encoder.encode(chunk));
  } catch {
    // the connection is already gone; stop tracking it rather than throw
    // again on the next broadcast or heartbeat
    removeClient(controller, roomId);
  }
}

// Called once a mutation has actually COMMITTED (src/lib/db.ts only calls
// this from a performAction/performWardrobeChange/performAdventure success
// path — never for a rejection), with the id of the room whose creature
// just changed. The payload is deliberately NOT the new creature state:
// it's a bare signal telling every other open tab IN THAT SAME ROOM to go
// re-fetch the authoritative page itself. If this ever started carrying
// state fields, a client could start rendering from the event alone and
// silently drift from SQLite — see PROCESS.md, Decision 5. Only clients
// connected to `roomId` are ever touched; every other room's clients are
// never iterated at all for this call.
export function broadcastUpdate(roomId: string): void {
  const set = roomClients.get(roomId);
  if (!set) return;
  const chunk = "event: update\ndata: {}\n\n";
  for (const controller of set) send(controller, chunk, roomId);
}

// A periodic comment line — ignored by EventSource's message handling, so
// it never looks like an "update" — just so an idle connection still sends
// *something* regularly. This is what lets a half-dead connection get
// noticed (enqueue throws, and it's dropped from its room's set), and it's
// the first thing to check against the real deployment: if a proxy buffers
// this response, neither the heartbeat nor a real update arrives at the
// client until the buffer flushes for some unrelated reason. Runs across
// every room — a heartbeat carries no room-specific information, so there's
// nothing to isolate here the way broadcastUpdate() has to.
const HEARTBEAT_MS = 15000;
const heartbeatTimer = setInterval(() => {
  for (const [roomId, set] of roomClients) {
    for (const controller of set) send(controller, ": heartbeat\n\n", roomId);
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();
