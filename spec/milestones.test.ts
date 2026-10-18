import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARE_MILESTONES, type ActionName, getMilestone } from "../src/lib/creature";

// Covers PROCESS.md, Decision 14 — the room's own shared, unranked lifetime
// care total and the flavor-text milestones derived from it: incremented by
// exactly 1 for every successful feed/play/walk/clean/sleep/adventure,
// NEVER for a rejected action and NEVER for a wardrobe change (cosmetic,
// free, and never gated by any rule — counting it would make the total
// trivially farmable). Shown room-wide, never attributed to a visitor —
// the concrete, checkable form of "this doesn't reopen Decision 6."
//
// Own instance (not spec/global-setup.ts's shared one): several of these
// tests assert on the room's EXACT total care count from a known starting
// point, which a shared instance's unrelated concurrent spec files could
// never guarantee isn't itself the thing proving — the same reasoning
// spec/concurrency.test.ts and spec/wardrobe.test.ts already give.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-milestones-"));

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

function totalCareText(doc: Document): number {
  const text = doc.querySelector(".milestone-progress")?.textContent ?? "";
  const match = text.match(/Room care so far:\s*(\d+)/);
  if (!match) throw new Error(`no "Room care so far" total found in: ${text}`);
  return Number(match[1]);
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

describe("milestones: a fresh room starts at zero", () => {
  it("shows total 0 and no milestone badge yet", async () => {
    const cookie = await newVisitor();
    const doc = await loadHome(cookie);
    expect(totalCareText(doc)).toBe(0);
    expect(doc.querySelector(".milestone-badge")).toBeNull();
    expect(doc.querySelector(".milestone-progress")?.textContent).toContain("10 toward the next milestone");
  });
});

describe("milestones: successful actions increment, rejections and wardrobe changes don't", () => {
  it("a successful feed increments the total by exactly 1", async () => {
    const cookie = await newVisitor();
    const before = totalCareText(await loadHome(cookie));
    const res = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(res.status).toBe(303);
    const after = totalCareText(await loadHome(cookie));
    expect(after).toBe(before + 1);
  });

  it("a rejected action leaves the total completely unchanged", async () => {
    const cookie = await newVisitor();
    // Drain energy via `play` until the server itself rejects one.
    let rejected = false;
    let totalBeforeRejection = -1;
    for (let i = 0; i < 20 && !rejected; i++) {
      const before = totalCareText(await loadHome(cookie));
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) {
        rejected = true;
        totalBeforeRejection = before;
      }
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBe(true);

    const afterRejection = totalCareText(await loadHome(cookie));
    expect(afterRejection, "a rejected action must not increment the total").toBe(totalBeforeRejection);
  });

  it("a successful wardrobe change does NOT increment the total — cosmetic, free, never gated by any rule", async () => {
    const cookie = await newVisitor();
    const before = totalCareText(await loadHome(cookie));
    const res = await post("/api/wardrobe", cookie, new URLSearchParams({ slot: "hat", value: "top-hat" }));
    expect(res.status).toBe(303);
    const after = totalCareText(await loadHome(cookie));
    expect(after, "wardrobe changes must never count toward the milestone total").toBe(before);
  });

  it("a successful adventure DOES increment the total — it's a shared activity, same category as the five care actions", async () => {
    const cookie = await newVisitor();
    const before = totalCareText(await loadHome(cookie));
    const res = await post("/api/adventure", cookie, new URLSearchParams());
    expect(res.status).toBe(303);
    const after = totalCareText(await loadHome(cookie));
    expect(after).toBe(before + 1);
  });
});

describe("milestones: crossing a threshold", () => {
  it("reaches the first milestone (10) at exactly the 10th successful action, not before", async () => {
    const cookie = await newVisitor();
    // `clean` never rejects regardless of stat state, so it's the simplest
    // way to rack up 10 genuinely successful actions without hitting any
    // energy/hunger gate.
    for (let i = 0; i < 9; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(res.status).toBe(303);
    }
    const before10th = await loadHome(cookie);
    expect(totalCareText(before10th)).toBe(9);
    expect(before10th.querySelector(".milestone-badge"), "no badge should show before the 10th action").toBeNull();

    const tenth = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
    expect(tenth.status).toBe(303);

    const after10th = await loadHome(cookie);
    expect(totalCareText(after10th)).toBe(10);
    expect(after10th.querySelector(".milestone-badge")?.textContent).toBe("Settling in");
    expect(after10th.querySelector(".milestone-progress")?.textContent).toContain("50 toward the next milestone");
  });
});

describe("milestones: never attributed to a visitor (Decision 6 still holds)", () => {
  it("the milestone progress text never names a session's display label", async () => {
    const cookie = await newVisitor();
    await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    const doc = await loadHome(cookie);
    const progressText = doc.querySelector(".milestone-progress")?.textContent ?? "";
    // "Test Visitor" is this test's own display name, chosen specifically
    // to be a string that would stand out if it ever leaked into this
    // room-level, unranked summary.
    expect(progressText).not.toContain("Test Visitor");
    // Every other field on the page CAN legitimately mention the visitor
    // (e.g. "Last action: Feed by Test Visitor") — only the milestone
    // block itself is asserted here, not the whole page.
    expect(doc.querySelector(".last-action")?.textContent).toContain("Test Visitor");
  });

  it("two different sessions in the same room see the identical, shared total — never a per-visitor breakdown", async () => {
    const host = await newVisitor();
    const roomId = extractRoomId(await loadHome(host));
    const member = await freshSession();
    await joinRoom(member, roomId);

    await post("/api/actions", host, new URLSearchParams({ action: "feed" }));
    await post("/api/actions", member, new URLSearchParams({ action: "clean" }));

    const hostTotal = totalCareText(await loadHome(host));
    const memberTotal = totalCareText(await loadHome(member));
    expect(hostTotal).toBe(2);
    expect(memberTotal).toBe(2);
  });
});

describe("milestones: no lost updates under genuine concurrency", () => {
  it("the final total equals exactly the number of actions that actually succeeded, under every valid ordering", async () => {
    // Same genuinely-concurrent-requests standard spec/concurrency.test.ts
    // already holds every other field to: real HTTP requests fired
    // together via Promise.all, never awaited one at a time, against the
    // one shared creature this test's arithmetic depends on.
    const host = await newVisitor();
    const roomId = extractRoomId(await loadHome(host));

    const sessions = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const cookie = await freshSession();
        await joinRoom(cookie, roomId);
        return cookie;
      }),
    );

    const before = totalCareText(await loadHome(host));

    // `clean` never rejects, so every one of these is guaranteed to
    // succeed regardless of arrival order — isolating this test to
    // proving "no lost updates in the counter," not "which actions
    // happened to be valid," the same narrowing spec/concurrency.test.ts's
    // own four-distinct-actions test deliberately makes.
    const actions: ActionName[] = ["clean", "clean", "clean", "clean"];
    const responses = await Promise.all(
      actions.map((action, i) => post("/api/actions", sessions[i], new URLSearchParams({ action }))),
    );
    for (const res of responses) expect(res.status).toBe(303);

    const after = totalCareText(await loadHome(host));
    expect(after, "expected the counter to reflect all 4 concurrent successes, with none lost to a race").toBe(before + 4);
  });
});

// Pure unit coverage of getMilestone() itself (no server needed) — the
// full migration-against-real-production-shaped-data regression lives in
// spec/milestones-migration.test.ts, following the established
// room-migration-backfill.test.ts / log-events-migration.test.ts pattern
// for a schema change landing after existing data.
describe("getMilestone: pure threshold logic", () => {
  it("reports no milestone reached and the first threshold as next, below 10", () => {
    const m = getMilestone(0);
    expect(m.reached).toBeNull();
    expect(m.label).toBeNull();
    expect(m.next).toBe(10);
    expect(m.progress).toBe(0);
  });

  it("reports the exact threshold reached, never the one above or below it", () => {
    expect(getMilestone(9).reached).toBeNull();
    expect(getMilestone(10).reached).toBe(10);
    expect(getMilestone(49).reached).toBe(10);
    expect(getMilestone(50).reached).toBe(50);
  });

  it("reports null `next` once every milestone is reached, with progress at 100", () => {
    const last = CARE_MILESTONES[CARE_MILESTONES.length - 1];
    const m = getMilestone(last + 1000);
    expect(m.reached).toBe(last);
    expect(m.next).toBeNull();
    expect(m.progress).toBe(100);
  });

  it("every threshold has a non-empty label", () => {
    for (const threshold of CARE_MILESTONES) {
      expect(getMilestone(threshold).label, `expected a label at threshold ${threshold}`).toBeTruthy();
    }
  });
});
