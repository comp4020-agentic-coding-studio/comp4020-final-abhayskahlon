import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionName } from "../src/lib/creature";

// Covers PROCESS.md, Decision 16 — the room's shared, unranked XP/level
// track: +20 xp for every successful feed/play/walk/clean/sleep/adventure,
// NEVER for a rejected action and NEVER for a wardrobe/appearance change
// (cosmetic, free, never gated by any rule — exactly the same reasoning
// spec/milestones.test.ts already establishes for totalCareActions, now
// applied to the second, independent xp track alongside it).
//
// Own instance (not spec/global-setup.ts's shared one) — same reasoning as
// spec/milestones.test.ts: several of these tests assert the room's EXACT
// xp from a known starting point.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-xp-"));

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

async function newVisitor(): Promise<string> {
  const cookie = await freshSession();
  const hostRes = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Test Visitor" }));
  if (hostRes.status !== 303) throw new Error(`expected hosting a room to succeed, got ${hostRes.status}`);
  return cookie;
}

async function joinRoom(cookie: string, roomId: string): Promise<void> {
  const res = await post("/api/rooms/join", cookie, new URLSearchParams({ name: "Test Visitor", roomCode: roomId }));
  expect(res.status, "expected joining the shared test room to succeed").toBe(303);
}

function extractRoomId(doc: Document): string {
  const id = doc.querySelector(".intro strong")?.textContent;
  if (!id) throw new Error("no room id found on the home page — expected to already be in a room");
  return id;
}

function xpText(doc: Document): { level: number; xp: number | null } {
  const el = doc.querySelector(".xp-progress");
  const level = Number(el?.getAttribute("data-level"));
  const text = el?.textContent ?? "";
  // Max-level text has no "/", normal text reads "N / M XP".
  const match = text.match(/(\d+)\s*\/\s*\d+\s*XP/) ?? text.match(/max level — (\d+) XP/);
  return { level, xp: match ? Number(match[1]) : null };
}

describe("xp: a fresh room starts at level 1 with 0 xp", () => {
  it("shows level 1 and 0 xp into the level", async () => {
    const cookie = await newVisitor();
    const doc = await loadHome(cookie);
    const { level, xp } = xpText(doc);
    expect(level).toBe(1);
    expect(xp).toBe(0);
  });
});

describe("xp: successful actions award exactly 20, rejections and cosmetic changes award 0", () => {
  it("a successful feed awards exactly 20 xp", async () => {
    const cookie = await newVisitor();
    const before = xpText(await loadHome(cookie)).xp ?? 0;
    const res = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(res.status).toBe(303);
    const after = xpText(await loadHome(cookie)).xp ?? 0;
    expect(after).toBe(before + 20);
  });

  it("a rejected action awards no xp at all", async () => {
    const cookie = await newVisitor();
    // Drain energy via `play` until the server itself rejects one.
    let rejected = false;
    let xpBeforeRejection = -1;
    for (let i = 0; i < 20 && !rejected; i++) {
      const before = xpText(await loadHome(cookie)).xp ?? 0;
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) {
        rejected = true;
        xpBeforeRejection = before;
      }
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBe(true);

    const afterRejection = xpText(await loadHome(cookie)).xp ?? 0;
    expect(afterRejection, "a rejected action must not award xp").toBe(xpBeforeRejection);
  });

  it("a successful wardrobe change does NOT award xp — cosmetic, free, never gated by any rule", async () => {
    const cookie = await newVisitor();
    const before = xpText(await loadHome(cookie)).xp ?? 0;
    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "top-hat" }));
    expect(res.status).toBe(303);
    const after = xpText(await loadHome(cookie)).xp ?? 0;
    expect(after, "wardrobe changes must never award xp").toBe(before);
  });

  it("a successful appearance switch does NOT award xp", async () => {
    const cookie = await newVisitor();
    const before = xpText(await loadHome(cookie)).xp ?? 0;
    const res = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "plip" }));
    expect(res.status).toBe(303);
    const after = xpText(await loadHome(cookie)).xp ?? 0;
    expect(after, "switching appearance must never award xp").toBe(before);
  });

  it("a successful adventure DOES award 20 xp — a genuine shared activity, same category as the five care actions", async () => {
    const cookie = await newVisitor();
    const before = xpText(await loadHome(cookie)).xp ?? 0;
    const res = await post("/api/adventure", cookie, new URLSearchParams());
    expect(res.status).toBe(303);
    const after = xpText(await loadHome(cookie)).xp ?? 0;
    expect(after).toBe(before + 20);
  });
});

describe("xp: leveling up", () => {
  it("reaches level 2 at exactly the 5th successful action (100 xp), not before", async () => {
    const cookie = await newVisitor();
    // `clean` never rejects regardless of stat state — same reasoning
    // spec/milestones.test.ts uses for its own threshold-crossing test.
    for (let i = 0; i < 4; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(res.status).toBe(303);
    }
    const before5th = xpText(await loadHome(cookie));
    expect(before5th.level).toBe(1);
    expect(before5th.xp).toBe(80);

    const fifth = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
    expect(fifth.status).toBe(303);

    const after5th = xpText(await loadHome(cookie));
    expect(after5th.level).toBe(2);
    expect(after5th.xp).toBe(0); // xpIntoLevel resets relative to level 2's own floor
  });
});

describe("xp: accessory unlocks are gated by the shared level, validated server-side", () => {
  it("rejects equipping a level-2 item before the room has reached level 2", async () => {
    const cookie = await newVisitor();
    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "beanie" }));
    expect(res.status).toBe(409);
    const doc = await loadHome(cookie);
    expect(doc.querySelector(".wardrobe-option.selected")?.textContent).not.toContain("Beanie");
  });

  it("allows equipping a level-2 item once the room has reached level 2", async () => {
    const cookie = await newVisitor();
    for (let i = 0; i < 5; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(res.status).toBe(303);
    }
    expect(xpText(await loadHome(cookie)).level).toBe(2);

    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "beanie" }));
    expect(res.status).toBe(303);
    const doc = await loadHome(cookie);
    const selected = Array.from(doc.querySelectorAll(".wardrobe-option.selected")).map((el) => el.textContent);
    expect(selected.some((text) => text?.includes("Beanie"))).toBe(true);
  });

  it("rejects the golden crown below level 5, even directly against the API", async () => {
    const cookie = await newVisitor();
    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "golden-crown" }));
    expect(res.status).toBe(409);
  });

  it("rejects bunny-ears for the oliver appearance even at a qualifying level", async () => {
    const cookie = await newVisitor();
    // bunny-ears unlocks at level 3 (300 cumulative xp = 15 successful
    // actions at 20 xp each).
    for (let i = 0; i < 15; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(res.status).toBe(303);
    }
    expect(xpText(await loadHome(cookie)).level).toBeGreaterThanOrEqual(3);

    const switchRes = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "oliver" }));
    expect(switchRes.status).toBe(303);

    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "bunny-ears" }));
    expect(res.status).toBe(409);
  });
});

describe("xp: no lost updates under genuine concurrency", () => {
  it("the final xp equals exactly 20 times the number of actions that actually succeeded", async () => {
    // Same genuinely-concurrent-requests standard spec/concurrency.test.ts
    // and spec/milestones.test.ts already hold every other field to.
    const host = await newVisitor();
    const roomId = extractRoomId(await loadHome(host));

    const sessions = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const cookie = await freshSession();
        await joinRoom(cookie, roomId);
        return cookie;
      }),
    );

    const before = xpText(await loadHome(host)).xp ?? 0;

    const actions: ActionName[] = ["clean", "clean", "clean", "clean"];
    const responses = await Promise.all(actions.map((action, i) => post("/api/actions", sessions[i], new URLSearchParams({ action }))));
    for (const res of responses) expect(res.status).toBe(303);

    const after = xpText(await loadHome(host)).xp ?? 0;
    expect(after, "expected xp to reflect all 4 concurrent successes, with none lost to a race").toBe(before + 4 * 20);
  });
});
