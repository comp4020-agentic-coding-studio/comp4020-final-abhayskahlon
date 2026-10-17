import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ActionName, type Stats, applyAction } from "../src/lib/creature";

// Closes the one evidence gap the design proposal originally asked for and
// the implementation commits never actually delivered (see CLAUDE.md,
// which used to claim a test like this existed before it did): proof that
// concurrent requests against the same creature produce no lost updates,
// not just that `Promise.all` resolves. See PROCESS.md, Decision 4.
//
// This fires real, genuinely concurrent HTTP requests at the ACTUAL running
// app (its own instance, same spawn pattern as spec/persistence.test.ts and
// spec/realtime.test.ts — this test needs an exact known starting state,
// which a shared instance can't guarantee) — never a mocked or in-process
// stand-in for the request/transaction path. The only thing called directly
// is `applyAction`, the real pure transition function `src/lib/db.ts` itself
// calls inside its transaction: it's the oracle this test checks the HTTP
// path's result against, not a reimplementation of it.
//
// Since PROCESS.md, Decision 13: a creature only exists inside a hosted
// room, so this file hosts ONE room in beforeAll and every "visitor" below
// JOINS that same room — the four concurrent sessions still act on the one
// shared creature this test's arithmetic depends on, exactly as before
// rooms existed.

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
let roomId: string;
const dbDir = mkdtempSync(join(tmpdir(), "commons-concurrency-"));

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

function post(path: string, cookie: string, body: URLSearchParams): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, cookie },
    body,
    redirect: "manual",
  });
}

// A fresh, independent session, with no room — the low-level building
// block newVisitor() (below) and the room host both use. Never a shared
// cookie jar, so each session genuinely comes from its own identity.
async function freshSession(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return extractSessionCookie(res);
}

async function loadHome(cookie: string): Promise<Document> {
  const res = await fetch(new URL("/", baseUrl), { headers: { cookie } });
  return new JSDOM(await res.text()).window.document;
}

function extractRoomId(doc: Document): string {
  const id = doc.querySelector(".intro strong")?.textContent;
  if (!id) throw new Error("no room id found on the home page — expected to already be in a room");
  return id;
}

async function joinRoom(cookie: string, room: string): Promise<void> {
  const res = await post("/api/rooms/join", cookie, new URLSearchParams({ name: "Test Visitor", roomCode: room }));
  expect(res.status, "expected joining the shared test room to succeed").toBe(303);
}

// A fresh session that immediately joins THIS FILE's one shared room — the
// replacement for "a fresh visitor on the one global creature" now that a
// creature only exists inside a room (PROCESS.md, Decision 13).
async function newVisitor(): Promise<string> {
  const cookie = await freshSession();
  await joinRoom(cookie, roomId);
  return cookie;
}

beforeAll(async () => {
  const port = await freePort();
  proc = spawn("node", ["./dist/server/entry.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: join(dbDir, "test.db") },
    stdio: "ignore",
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilUp(baseUrl);

  const hostCookie = await freshSession();
  const hostRes = await post("/api/rooms/host", hostCookie, new URLSearchParams({ name: "Test Host" }));
  expect(hostRes.status).toBe(303);
  roomId = extractRoomId(await loadHome(hostCookie));
});

afterAll(() => {
  proc?.kill();
  rmSync(dbDir, { force: true, recursive: true });
});

function parseStats(doc: Document): Stats {
  const [hunger, energy, happiness, cleanliness] = [...doc.querySelectorAll(".stat-value")].map((el) =>
    Number(el.textContent),
  );
  return { hunger, energy, happiness, cleanliness };
}

function statsEqual(a: Stats, b: Stats): boolean {
  return a.hunger === b.hunger && a.energy === b.energy && a.happiness === b.happiness && a.cleanliness === b.cleanliness;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([items[i], ...tail]);
  }
  return result;
}

// The oracle: what a SEQUENTIAL application of this order of actions would
// produce, computed with the real transition function — not a mock of it.
function simulateSequential(order: ActionName[], initial: Stats): Stats {
  let stats = initial;
  const now = new Date();
  for (const action of order) {
    const outcome = applyAction(action, { stats, activity: "idle", activityUntil: null }, now);
    if (!outcome.ok) {
      throw new Error(`unexpected rejection simulating ${action} from ${JSON.stringify(stats)}: ${outcome.reason}`);
    }
    stats = outcome.result.stats;
  }
  return stats;
}

describe("concurrency", () => {
  it("applies concurrent actions from independent sessions with no lost updates", async () => {
    // Matches db.ts's hostRoom() default on a freshly hosted room — this
    // room's creature was just created, so this is the known starting point.
    const INITIAL_STATS: Stats = { hunger: 70, energy: 70, happiness: 70, cleanliness: 70 };

    // One of each action except `sleep` (kept out to avoid also permuting
    // activity-state transitions — a deliberately narrower, still genuine,
    // concurrency scenario). None of these should be rejected from the
    // initial stats above, regardless of what order they land in.
    const concurrentActions: ActionName[] = ["feed", "play", "walk", "clean"];

    // Four independent sessions, all in the same room — distinguished by
    // their actual cookies, never by their randomly-generated display
    // labels (which may legitimately coincide; see src/lib/session.ts).
    const cookies = await Promise.all(concurrentActions.map(() => newVisitor()));
    const uniqueCookies = new Set(cookies);
    expect(uniqueCookies.size, "expected four genuinely distinct sessions").toBe(concurrentActions.length);

    // Fired together, not awaited one at a time: genuinely concurrent
    // requests against the one shared creature.
    const responses = await Promise.all(
      concurrentActions.map((action, i) => post("/api/actions", cookies[i], new URLSearchParams({ action }))),
    );
    for (const [i, res] of responses.entries()) {
      expect(res.status, `expected ${concurrentActions[i]} to succeed`).toBe(303);
    }

    const doc = await loadHome(cookies[0]);
    const finalStats = parseStats(doc);

    // Every stat stays inside its bound regardless of what happened.
    for (const [key, value] of Object.entries(finalStats)) {
      expect(value, `${key} out of bounds`).toBeGreaterThanOrEqual(0);
      expect(value, `${key} out of bounds`).toBeLessThanOrEqual(100);
    }

    // No lost updates: the final state must equal what SOME sequential
    // ordering of these four actions would have produced. A silently
    // dropped or double-applied effect would match none of them, since
    // these four actions' combined deltas never clamp against the 0/100
    // bound from this starting point (so every ordering's arithmetic is
    // exact, not just "some valid-looking number").
    const possibleOutcomes = permutations(concurrentActions).map((order) => simulateSequential(order, INITIAL_STATS));
    const matchesSomeOrdering = possibleOutcomes.some((candidate) => statsEqual(candidate, finalStats));
    expect(
      matchesSomeOrdering,
      `final stats ${JSON.stringify(finalStats)} did not match any of the ${possibleOutcomes.length} valid sequential orderings — a lost or duplicated update`,
    ).toBe(true);

    // Every one of the four actions left its own care_events row — none
    // lost, none duplicated. Matched on each action's fixed summary text
    // (real output of the same applyAction, not a re-typed guess), never on
    // session display labels.
    const historyText = [...doc.querySelectorAll(".history-list li")].map((li) => li.textContent ?? "");
    expect(historyText).toHaveLength(concurrentActions.length);
    for (const action of concurrentActions) {
      const expectedSummary = simulateOneSummary(action, INITIAL_STATS);
      const matches = historyText.filter((text) => text.includes(expectedSummary));
      expect(matches, `expected exactly one care_events entry for ${action}`).toHaveLength(1);
    }
  });
});

// Each of these four actions' summary is fixed text, independent of the
// input stats (only `sleep`, not used here, interpolates anything) — so
// this safely reuses the real function to get the exact string the app
// itself produces, rather than hand-copying it and risking drift.
function simulateOneSummary(action: ActionName, stats: Stats): string {
  const outcome = applyAction(action, { stats, activity: "idle", activityUntil: null }, new Date());
  if (!outcome.ok) throw new Error(`unexpected rejection getting ${action}'s summary: ${outcome.reason}`);
  return outcome.result.summary;
}
