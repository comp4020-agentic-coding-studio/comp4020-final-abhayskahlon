import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOM_CODE_LENGTH } from "../src/lib/room";

// Covers the invariants PROCESS.md, Decision 13 and docs/adr/0002-multi-
// room-identity-and-access-control.md actually commit to, that no other
// spec file (each updated only to host/join a room as setup) exercises
// directly: hosting assigns a valid code and host attribution; joining
// validates against the database with a real, distinct rejection reason
// for a bad name versus an unknown code; two sessions in the same room
// genuinely share one creature; a session acting in one room can never
// touch another room's creature or history — the core cross-room security
// property this whole feature exists to guarantee; care-event attribution
// survives a session later switching rooms; room membership persists
// across a reload; and switching always overwrites.
//
// Own instance (not spec/global-setup.ts's shared one): several of these
// tests assert on a room being completely untouched by another room's
// activity, which a shared instance's unrelated concurrent spec files
// could never guarantee isn't itself the thing proving — the same
// reasoning spec/concurrency.test.ts and spec/wardrobe.test.ts already give.

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (attempt >= 100) throw new Error(`nothing answering at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let proc: ChildProcess;
let baseUrl: string;
const dbDir = mkdtempSync(join(tmpdir(), "commons-rooms-"));

beforeAll(async () => {
  const port = await freePort();
  proc = spawn("node", ["./dist/server/entry.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: join(dbDir, "test.db") },
    stdio: "ignore",
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilUp(baseUrl);
});

afterAll(() => {
  proc?.kill();
  rmSync(dbDir, { force: true, recursive: true });
});

function post(path: string, cookie: string, body: URLSearchParams): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, cookie },
    body,
    redirect: "manual",
  });
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

async function freshSession(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return extractSessionCookie(res);
}

// "?enter=1": the entry page is the default for a bare GET / even once a
// session has a room — see src/pages/index.astro's showEntry comment.
// Every call site in this file already expects the room view itself (it's
// what "loadHome" has always meant here); a bare, parameter-less "/" is
// tested separately below, in its own describe block, specifically because
// its behaviour is now different from what this helper returns.
async function loadHome(cookie: string): Promise<Document> {
  const res = await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie } });
  return new JSDOM(await res.text()).window.document;
}

async function loadBareHome(cookie?: string): Promise<Document> {
  const res = await fetch(new URL("/", baseUrl), cookie ? { headers: { cookie } } : undefined);
  return new JSDOM(await res.text()).window.document;
}

function extractRoomId(doc: Document): string {
  const id = doc.querySelector(".intro strong")?.textContent;
  if (!id) throw new Error("no room id found on the home page — expected to already be in a room");
  return id;
}

function isEntryPage(doc: Document): boolean {
  return doc.getElementById("entry-heading") !== null;
}

async function hostRoom(name: string): Promise<{ cookie: string; roomId: string }> {
  const cookie = await freshSession();
  const res = await post("/api/rooms/host", cookie, new URLSearchParams({ name }));
  expect(res.status, "expected hosting a room to succeed").toBe(303);
  const roomId = extractRoomId(await loadHome(cookie));
  return { cookie, roomId };
}

describe("hosting", () => {
  it("assigns a valid-format, unique room code and records the host", async () => {
    const a = await hostRoom("Alice");
    expect(a.roomId).toHaveLength(ROOM_CODE_LENGTH);
    expect(a.roomId).toMatch(/^[A-Z0-9]+$/);

    const doc = await loadHome(a.cookie);
    expect(doc.querySelector(".panel-note")?.textContent).toContain("Hosted by Alice");

    // A second room hosted right after gets its own, different code —
    // never the same one reused.
    const b = await hostRoom("Bob");
    expect(b.roomId).not.toBe(a.roomId);
  });

  it("rejects an empty or whitespace-only name before ever creating a room", async () => {
    const cookie = await freshSession();
    const res = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "   " }));
    expect(res.status).toBe(400);

    // Never promoted to a room member by a rejected host attempt — still
    // sees the entry page, not Milo's.
    const doc = await loadHome(cookie);
    expect(isEntryPage(doc)).toBe(true);
  });
});

describe("joining", () => {
  it("lets a second visitor join an existing room by its code", async () => {
    const { roomId } = await hostRoom("Host");
    const memberCookie = await freshSession();

    const res = await post("/api/rooms/join", memberCookie, new URLSearchParams({ name: "Member", roomCode: roomId }));
    expect(res.status).toBe(303);

    const doc = await loadHome(memberCookie);
    expect(extractRoomId(doc)).toBe(roomId);
    expect(isEntryPage(doc)).toBe(false);
  });

  it("rejects a well-formed code that matches no room, with a real reason, never creating a room for it", async () => {
    const cookie = await freshSession();
    const res = await post("/api/rooms/join", cookie, new URLSearchParams({ name: "Nobody", roomCode: "ZZZZZZ" }));
    expect(res.status).toBe(404);
    const reason = await res.text();
    expect(reason).toBe("no room with that code");
    expect(res.headers.get("content-type") ?? "").not.toContain("html");

    // Still on the entry page — the rejected attempt never moved this
    // session into any room.
    const doc = await loadHome(cookie);
    expect(isEntryPage(doc)).toBe(true);
  });

  it("rejects a malformed code (wrong length / outside the alphabet) distinctly from an unknown-but-well-formed one", async () => {
    const cookie = await freshSession();
    const res = await post("/api/rooms/join", cookie, new URLSearchParams({ name: "Nobody", roomCode: "short" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("that doesn't look like a room code");
  });

  it("rejects an empty or whitespace-only name even with a valid room code", async () => {
    const { roomId } = await hostRoom("Host2");
    const cookie = await freshSession();
    const res = await post("/api/rooms/join", cookie, new URLSearchParams({ name: "", roomCode: roomId }));
    expect(res.status).toBe(400);
  });

  it("room codes are matched case-insensitively and ignore surrounding whitespace", async () => {
    const { roomId } = await hostRoom("Host3");
    const cookie = await freshSession();
    const res = await post(
      "/api/rooms/join",
      cookie,
      new URLSearchParams({ name: "Member", roomCode: ` ${roomId.toLowerCase()} ` }),
    );
    expect(res.status).toBe(303);
  });
});

describe("cross-room isolation", () => {
  it("two sessions in the same room see each other's actions and history", async () => {
    const { cookie: hostCookie, roomId } = await hostRoom("Host");
    const memberCookie = await freshSession();
    await post("/api/rooms/join", memberCookie, new URLSearchParams({ name: "Member", roomCode: roomId }));

    const feedRes = await post("/api/actions", memberCookie, new URLSearchParams({ action: "feed" }));
    expect(feedRes.status).toBe(303);

    const hostView = await loadHome(hostCookie);
    expect(hostView.querySelector(".last-action")?.textContent).toContain("Feed");
    expect(hostView.querySelector(".history-list")?.textContent).toContain("fed Milo");
  });

  // The key new security property this feature exists to guarantee: a
  // session acting in room A must never affect room B's creature or
  // history, no matter what it sends — and there is nothing room-shaped in
  // the request for it to even try (docs/adr/0002).
  it("a session's action in one room never affects a different room's creature or history", async () => {
    const roomA = await hostRoom("Alice");
    const roomB = await hostRoom("Carol");
    expect(roomA.roomId).not.toBe(roomB.roomId);

    const beforeB = await loadHome(roomB.cookie);
    const statsBeforeB = [...beforeB.querySelectorAll(".stat-value")].map((el) => el.textContent);
    const historyBeforeB = beforeB.querySelector(".history-list")?.textContent ?? "";

    // Several actions in room A...
    for (const action of ["feed", "play", "walk"]) {
      await post("/api/actions", roomA.cookie, new URLSearchParams({ action }));
    }

    // ...leave room B completely untouched.
    const afterB = await loadHome(roomB.cookie);
    const statsAfterB = [...afterB.querySelectorAll(".stat-value")].map((el) => el.textContent);
    const historyAfterB = afterB.querySelector(".history-list")?.textContent ?? "";
    expect(statsAfterB).toEqual(statsBeforeB);
    expect(historyAfterB).toBe(historyBeforeB);
    expect(historyAfterB).not.toContain("fed Milo");
  });

  it("care-event attribution is captured at action time and survives a session later switching rooms", async () => {
    const roomA = await hostRoom("Alice");
    const roomB = await hostRoom("Carol");

    const feedRes = await post("/api/actions", roomA.cookie, new URLSearchParams({ action: "feed" }));
    expect(feedRes.status).toBe(303);

    // A separate reader, still in room A, confirms the feed is recorded
    // there before Alice's own session ever switches anywhere.
    const roomAReader = await freshSession();
    await post("/api/rooms/join", roomAReader, new URLSearchParams({ name: "Reader", roomCode: roomA.roomId }));
    expect((await loadHome(roomAReader)).querySelector(".history-list")?.textContent).toContain("fed Milo");

    // Alice's own session now switches into room B entirely (joining
    // always overwrites — PROCESS.md, Decision 13). Room A's history is
    // unaffected by this switch: the feed stays recorded against the room
    // it actually happened in, not against wherever Alice's session later
    // ends up.
    const switchRes = await post("/api/rooms/join", roomA.cookie, new URLSearchParams({ name: "Alice", roomCode: roomB.roomId }));
    expect(switchRes.status).toBe(303);
    expect((await loadHome(roomAReader)).querySelector(".history-list")?.textContent).toContain("fed Milo");

    // Room B — which Alice's session just switched into — was never
    // touched by that earlier feed; it's still the fresh room it was
    // hosted as.
    const roomBView = await loadHome(roomA.cookie); // roomA.cookie now belongs to room B
    expect(roomBView.querySelector(".history-list")?.textContent ?? "").not.toContain("fed Milo");
  });
});

describe("room membership persistence and switching", () => {
  // Since the entry-page-by-default change: a bare, parameter-less reload
  // no longer renders the room directly (that's the whole point of the
  // change — see src/pages/index.astro's showEntry comment), but the
  // session's room MEMBERSHIP itself is completely untouched by that UI
  // default. This proves both halves: the bare reload shows the entry
  // page (with an explicit "Continue to your room" link naming the real
  // room), and the SAME session, with NO new cookie, still resumes that
  // exact room the moment it explicitly asks via "?enter=1" — nothing
  // about the underlying session or room state changed, only which page a
  // context-free visit defaults to.
  it("shows the entry page (not the room) on a bare reload, but keeps the session's room membership intact", async () => {
    const { cookie, roomId } = await hostRoom("Alice");

    const bare = await fetch(new URL("/", baseUrl), { headers: { cookie } });
    expect(bare.headers.get("set-cookie")).toBeNull(); // same session recognised, not replaced

    const bareDoc = new JSDOM(await bare.text()).window.document;
    expect(isEntryPage(bareDoc)).toBe(true);
    // The explicit re-entry affordance names the real room, proving
    // membership survived even though this page isn't showing it directly.
    expect(bareDoc.querySelector(".entry-returning")?.textContent ?? "").toContain(roomId);

    const explicit = await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie } });
    expect(explicit.headers.get("set-cookie")).toBeNull();
    const explicitDoc = new JSDOM(await explicit.text()).window.document;
    expect(isEntryPage(explicitDoc)).toBe(false);
    expect(extractRoomId(explicitDoc)).toBe(roomId);
  });

  it("joining or hosting a new room overwrites the session's previous room membership", async () => {
    const roomA = await hostRoom("Alice");
    const roomB = await hostRoom("Someone else");

    // roomA.cookie switches into room B.
    const switchRes = await post("/api/rooms/join", roomA.cookie, new URLSearchParams({ name: "Alice", roomCode: roomB.roomId }));
    expect(switchRes.status).toBe(303);

    const doc = await loadHome(roomA.cookie);
    expect(extractRoomId(doc)).toBe(roomB.roomId);
    expect(extractRoomId(doc)).not.toBe(roomA.roomId);
  });

  it("'/?switch=1' shows the entry experience again for a session already in a room", async () => {
    const { cookie } = await hostRoom("Alice");
    const res = await fetch(new URL("/?switch=1", baseUrl), { headers: { cookie } });
    const doc = new JSDOM(await res.text()).window.document;
    expect(isEntryPage(doc)).toBe(true);
  });
});

// The entry page is the default for a bare GET /, for every kind of
// visitor — not just the first-time one it was always correct for. This is
// a deliberate navigation change, not a security one: every mutating route
// still derives its room exclusively from the trusted session cookie,
// completely unaffected by which page a plain GET / happens to render (see
// docs/adr/0002, unchanged by this). What changes is purely which page
// greets a context-free visit to the bare URL.
describe("entry page is the default for a bare GET /, for every visitor", () => {
  it("a fresh, cookie-less visitor sees the entry page", async () => {
    const doc = await loadBareHome();
    expect(isEntryPage(doc)).toBe(true);
  });

  it("a returning visitor with an existing room also sees the entry page on a bare GET /, not their room directly", async () => {
    const { cookie } = await hostRoom("Returning Visitor");
    const doc = await loadBareHome(cookie);
    expect(isEntryPage(doc)).toBe(true);
  });

  it("the returning visitor's session and room membership remain valid — they can still explicitly re-enter with no new cookie and no re-hosting or re-joining", async () => {
    const { cookie, roomId } = await hostRoom("Returning Visitor");

    // The bare visit above already proved this shows the entry page; this
    // proves the session underneath is still exactly the one that hosted
    // the room (not silently replaced or invalidated) and can resume it.
    const bare = await fetch(new URL("/", baseUrl), { headers: { cookie } });
    expect(bare.headers.get("set-cookie")).toBeNull();

    const reentered = await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie } });
    expect(reentered.headers.get("set-cookie")).toBeNull(); // same session, not a new one
    const doc = new JSDOM(await reentered.text()).window.document;
    expect(isEntryPage(doc)).toBe(false);
    expect(extractRoomId(doc)).toBe(roomId);
  });

  it("a mutating action still round-trips correctly: it redirects straight back to the room, not to the entry page", async () => {
    const { cookie } = await hostRoom("Actor");
    const res = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(res.status).toBe(303);
    // The server's own Location header is the actual contract every real
    // browser follows — this is what proves the redirect target itself
    // carries "?enter=1", not just that *a* subsequent fetch happens to
    // find the room.
    expect(res.headers.get("location")).toBe("/?enter=1");

    const after = await fetch(new URL(res.headers.get("location") ?? "/", baseUrl), { headers: { cookie } });
    const doc = new JSDOM(await after.text()).window.document;
    expect(isEntryPage(doc)).toBe(false);
    expect(doc.querySelector(".last-action")?.textContent).toContain("Feed");
  });

  it("hosting and joining still redirect straight into the room, never back to the entry page", async () => {
    const hostCookie = await freshSession();
    const hostRes = await post("/api/rooms/host", hostCookie, new URLSearchParams({ name: "Host" }));
    expect(hostRes.status).toBe(303);
    expect(hostRes.headers.get("location")).toBe("/?enter=1");
    const hostDoc = new JSDOM(await (await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie: hostCookie } })).text())
      .window.document;
    expect(isEntryPage(hostDoc)).toBe(false);
    const roomId = extractRoomId(hostDoc);

    const joinCookie = await freshSession();
    const joinRes = await post("/api/rooms/join", joinCookie, new URLSearchParams({ name: "Joiner", roomCode: roomId }));
    expect(joinRes.status).toBe(303);
    expect(joinRes.headers.get("location")).toBe("/?enter=1");
    const joinDoc = new JSDOM(await (await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie: joinCookie } })).text())
      .window.document;
    expect(isEntryPage(joinDoc)).toBe(false);
    expect(extractRoomId(joinDoc)).toBe(roomId);
  });
});
