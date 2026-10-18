import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Covers PROCESS.md, Decision 15 — switching which of the five fixed,
// authored looks the room's ONE shared creature renders as. The central
// property under test: switching appearance changes ONLY the appearance —
// stats, xp, totalCareActions, hat/neckwear/glasses, and care history are
// all byte-for-byte identical before and after. This is what makes it a
// shared cosmetic, not a second creature or a reset.
//
// Own instance (not spec/global-setup.ts's shared one) — same reasoning
// every other spec file here gives for exact-state assertions.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-appearance-"));

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

function statsSnapshot(doc: Document): { hunger: string | null; energy: string | null; happiness: string | null; cleanliness: string | null } {
  return {
    hunger: doc.querySelector('[data-stat="hunger"] .stat-value')?.textContent ?? null,
    energy: doc.querySelector('[data-stat="energy"] .stat-value')?.textContent ?? null,
    happiness: doc.querySelector('[data-stat="happiness"] .stat-value')?.textContent ?? null,
    cleanliness: doc.querySelector('[data-stat="cleanliness"] .stat-value')?.textContent ?? null,
  };
}

function historyLength(doc: Document): number {
  return doc.querySelectorAll(".history-list li").length;
}

describe("appearance switching: a cosmetic change, never a reset", () => {
  it("switches the rendered creature without touching stats, xp, milestones, or history", async () => {
    const cookie = await newVisitor();
    // Do a few real things first so there's real state to prove untouched.
    await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "top-hat" }));

    const before = await loadHome(cookie);
    const statsBefore = statsSnapshot(before);
    const totalBefore = before.querySelector(".milestone-progress")?.textContent?.match(/Room care so far:\s*(\d+)/)?.[1];
    const xpBefore = before.querySelector(".xp-progress")?.getAttribute("data-level");
    const historyBefore = historyLength(before);

    const res = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "plip" }));
    expect(res.status).toBe(303);

    const after = await loadHome(cookie);
    expect(statsSnapshot(after)).toEqual(statsBefore);
    expect(after.querySelector(".milestone-progress")?.textContent?.match(/Room care so far:\s*(\d+)/)?.[1]).toBe(totalBefore);
    expect(after.querySelector(".xp-progress")?.getAttribute("data-level")).toBe(xpBefore);
    // The hat equipped before the switch is still equipped — equip state
    // is shared/global, independent of which appearance is selected.
    expect(after.querySelector(".wardrobe-option.selected")?.textContent).toContain("Top Hat");
    // The switch itself adds exactly one new history row ("now appears as Plip").
    expect(historyLength(after)).toBe(historyBefore + 1);
    expect(after.querySelector(".history-list")?.textContent).toContain("now appears as Plip");
  });

  it("rejects an unknown appearance value, changing nothing", async () => {
    const cookie = await newVisitor();
    const before = await loadHome(cookie);
    const historyBefore = historyLength(before);

    const res = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "dragon" }));
    expect(res.status).toBe(400);

    const after = await loadHome(cookie);
    expect(historyLength(after)).toBe(historyBefore);
  });

  it("requires a room before switching appearance", async () => {
    const cookie = await freshSession();
    const res = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "bella" }));
    expect(res.status).toBe(403);
  });

  it("is visible to every session in the same room through the same live-state refresh everything else uses", async () => {
    const host = await newVisitor();
    const roomDoc = await loadHome(host);
    const roomId = roomDoc.querySelector(".intro strong")?.textContent;
    if (!roomId) throw new Error("expected a room id");

    const member = await freshSession();
    const joinRes = await post("/api/rooms/join", member, new URLSearchParams({ name: "Member", roomCode: roomId }));
    expect(joinRes.status).toBe(303);

    const res = await post("/api/appearance", host, new URLSearchParams({ appearance: "simbaa" }));
    expect(res.status).toBe(303);

    const memberDoc = await loadHome(member);
    expect(memberDoc.querySelector(".history-list")?.textContent).toContain("now appears as Simbaa");
  });
});

describe("appearance: history attribution survives a later switch", () => {
  it("a care action's recorded appearance reflects what was active AT THAT TIME, unaffected by a later switch", async () => {
    const cookie = await newVisitor();

    // Feed while still the default "milo" appearance.
    const feedRes = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(feedRes.status).toBe(303);

    // Switch, then act again as the new appearance.
    const switchRes = await post("/api/appearance", cookie, new URLSearchParams({ appearance: "bella" }));
    expect(switchRes.status).toBe(303);
    const cleanRes = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
    expect(cleanRes.status).toBe(303);

    // Switch again — this must not retroactively change either earlier
    // history row's recorded appearance.
    await post("/api/appearance", cookie, new URLSearchParams({ appearance: "oliver" }));

    const doc = await loadHome(cookie);
    const entries = Array.from(doc.querySelectorAll(".history-list li")).map((el) => el.textContent ?? "");
    // Most recent first (src/lib/db.ts's listRecentCareHistory orders
    // desc(id)) — the "now appears as Oliver" switch, then the clean
        // (as Bella), then the switch to Bella, then the original feed
    // (as Milo).
    const cleanEntry = entries.find((text) => text.includes("cleaned"));
    const feedEntry = entries.find((text) => text.includes("fed"));
    expect(cleanEntry, "expected a 'cleaned' entry in history").toBeTruthy();
    expect(feedEntry, "expected a 'fed' entry in history").toBeTruthy();
    // The clean happened AFTER switching to Bella — its history row must
    // say so, while the earlier feed (while still "milo") must not.
    expect(cleanEntry).toContain("Bella");
    expect(feedEntry).toContain("Milo");
    expect(feedEntry).not.toContain("Bella");
  });
});

describe("appearance/xp: room isolation", () => {
  it("switching appearance or earning xp in one room never affects a different room's creature", async () => {
    const roomA = await newVisitor();
    const roomB = await newVisitor();

    const beforeB = await loadHome(roomB);
    const levelBeforeB = beforeB.querySelector(".xp-progress")?.getAttribute("data-level");
    const historyBeforeB = beforeB.querySelector(".history-list")?.textContent ?? "";

    await post("/api/appearance", roomA, new URLSearchParams({ appearance: "oliver" }));
    await post("/api/actions", roomA, new URLSearchParams({ action: "feed" }));

    const afterB = await loadHome(roomB);
    expect(afterB.querySelector(".xp-progress")?.getAttribute("data-level")).toBe(levelBeforeB);
    expect(afterB.querySelector(".history-list")?.textContent ?? "").toBe(historyBeforeB);
    expect(afterB.querySelector(".history-list")?.textContent ?? "").not.toContain("now appears as Oliver");
  });
});
