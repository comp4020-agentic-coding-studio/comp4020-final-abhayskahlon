import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Covers the shared, cosmetic wardrobe: a change touches no stat and no
// activity rule (so there is no rejection path to test beyond an unknown
// slot/option), is visible to every session in the same room, and is
// recorded in Recent care with accurate attribution — same as every other
// shared change here.
//
// Also regression coverage for a real lost-update bug found in review: the
// original /api/wardrobe took a full {hat, neckwear} pair from the client,
// which included whatever the client's own rendered page happened to show
// for the slot it wasn't changing. Two changes to different slots in
// succession — or one session acting on a page it loaded before another
// session's change — could silently revert that other slot back to a
// stale value. The fix (src/lib/db.ts's performWardrobeChange) takes
// exactly one {slot, value} and reads the untouched slot fresh inside the
// same transaction; these tests prove both the sequential case (the one
// actually reproduced) and genuine concurrency.
//
// Own instance (not spec/global-setup.ts's shared one): these tests assert
// on ".last-action"'s exact text, which the shared instance's other spec
// files (sessions.test.ts in particular) also assert on — confirmed by a
// real failure while writing these against the shared instance, where a
// wardrobe-test write landed as "Last action" in between sessions.test.ts's
// own feed and its assertion. The same reasoning spec/concurrency.test.ts
// and spec/persistence.test.ts already give for owning their own instance.
//
// Since PROCESS.md, Decision 13: a creature only exists inside a hosted
// room — newVisitor() hosts a fresh room for the single-session test below,
// and the concurrent test explicitly joins both sessions into the SAME
// room so they genuinely share one creature's hat/neckwear.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-wardrobe-"));

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

async function freshSession(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

// "?enter=1": the entry page is the default for a bare GET / even once a
// session has a room — see src/pages/index.astro's showEntry comment.
async function loadHome(cookie: string): Promise<Document> {
  const res = await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie } });
  return new JSDOM(await res.text()).window.document;
}

function extractRoomId(doc: Document): string {
  const id = doc.querySelector(".intro strong")?.textContent;
  if (!id) throw new Error("no room id found on the home page — expected to already be in a room");
  return id;
}

async function newVisitor(): Promise<string> {
  const cookie = await freshSession();
  const hostRes = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Test Visitor" }));
  if (hostRes.status !== 303) throw new Error(`expected hosting a room to succeed, got ${hostRes.status}`);
  return cookie;
}

describe("wardrobe", () => {
  it("changing one slot never reverts the other slot's latest persisted value", async () => {
    const cookie = await newVisitor();

    const hatRes = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "top-hat" }));
    expect(hatRes.status).toBe(303);

    // This request says nothing at all about the hat — the old contract
    // would have required the client to echo its own (by now correct, but
    // in the original bug potentially stale) copy of it. It shouldn't
    // need to, and shouldn't be able to accidentally clear it either.
    const neckRes = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "neckwear", value: "scarf" }));
    expect(neckRes.status).toBe(303);

    const doc = await loadHome(cookie);
    // Checked via element presence (never a bare .className string read —
    // SVG elements' `className` is not a plain string in real browsers,
    // only querySelector is reliable here) for the hat and neckwear
    // groups Milo.astro actually renders.
    expect(doc.querySelector(".milo-hat-top"), "the hat set first must survive the later neckwear change").not.toBeNull();
    expect(doc.querySelector(".milo-scarf")).not.toBeNull();
    expect(doc.querySelector(".last-action")?.textContent).toContain("Wardrobe");
    expect(doc.querySelector(".history-list")?.textContent).toContain("dressed Milo");
    expect(doc.querySelector(".history-list")?.textContent).toContain("Top Hat, Scarf");

    // Taking the hat off again is just as valid a choice as wearing one —
    // never a rejection — and must leave the scarf exactly as it is.
    const off = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "" }));
    expect(off.status).toBe(303);
    const afterOff = await loadHome(cookie);
    expect(afterOff.querySelector(".milo-hat-top")).toBeNull();
    expect(afterOff.querySelector(".milo-scarf"), "removing the hat must not also remove the scarf").not.toBeNull();
    expect(afterOff.querySelector(".history-list")?.textContent).toContain("now wearing: Scarf");
  });

  it("rejects an unknown slot or an option outside that slot's vocabulary, changing nothing", async () => {
    const cookie = await newVisitor();
    const before = await loadHome(cookie);
    const lastActionBefore = before.querySelector(".last-action")?.textContent ?? null;

    const badSlot = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "shoes", value: "" }));
    expect(badSlot.status).toBe(400);

    const badOption = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "crown" }));
    expect(badOption.status).toBe(400);

    // Cross-slot: a real neckwear value submitted for the hat slot is just
    // as invalid as a nonsense string — the vocabularies aren't interchangeable.
    const wrongSlot = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "scarf" }));
    expect(wrongSlot.status).toBe(400);

    const after = await loadHome(cookie);
    expect(after.querySelector(".last-action")?.textContent ?? null).toBe(lastActionBefore);
  });

  // performWardrobeChange (src/lib/db.ts) reads the untouched slot fresh
  // inside its own transaction specifically so this can never happen.
  it("two genuinely concurrent changes to different slots both survive — no lost update", async () => {
    // Both sessions must be IN THE SAME ROOM for this to test what it
    // claims to: A hosts, B joins A's room, rather than each getting its
    // own independent creature.
    const cookieA = await newVisitor();
    const roomId = extractRoomId(await loadHome(cookieA));
    const cookieB = await freshSession();
    const joinRes = await post("/api/rooms/join", cookieB, new URLSearchParams({ name: "Test Visitor B", roomCode: roomId }));
    expect(joinRes.status, "expected joining A's room to succeed").toBe(303);
    expect(cookieA).not.toBe(cookieB);

    // Fired together, not awaited one at a time: A sets the hat, B sets
    // the neckwear, genuinely concurrently, against the one shared row.
    const [resA, resB] = await Promise.all([
      post("/api/wardrobe", cookieA, new URLSearchParams({ slot: "hat", value: "party-hat" })),
      post("/api/wardrobe", cookieB, new URLSearchParams({ slot: "neckwear", value: "bow-tie" })),
    ]);
    expect(resA.status).toBe(303);
    expect(resB.status).toBe(303);

    const doc = await loadHome(cookieA);
    expect(doc.querySelector(".milo-hat-party"), "A's hat must not be lost to B's concurrent neckwear change").not.toBeNull();
    expect(doc.querySelector(".milo-bow-tie"), "B's neckwear must not be lost to A's concurrent hat change").not.toBeNull();
  });
});
