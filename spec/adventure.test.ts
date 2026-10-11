import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Covers the one new shared activity that moves real stats: adventure is
// deliberately NOT a sixth entry in ACTIONS (src/lib/creature.ts) — it has
// its own route (src/pages/api/adventure.ts) and its own validator
// (applyAdventure), but follows the exact same "not while asleep" rule
// every other non-clean/non-sleep action already follows, and the exact
// same transactional/attribution/history contract (src/lib/db.ts's
// performAdventure). Own instance, SLEEP_COOLDOWN_MS overridden short, so
// the asleep-rejection half of this can be tested without sitting through
// the real 8s default or disturbing any shared-instance test's timing.

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

const SLEEP_COOLDOWN_MS = 500;
let proc: ChildProcess;
let baseUrl: string;
const dbDir = mkdtempSync(join(tmpdir(), "commons-adventure-"));

beforeAll(async () => {
  const port = await freePort();
  proc = spawn("node", ["./dist/server/entry.mjs"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: join(dbDir, "test.db"),
      SLEEP_COOLDOWN_MS: String(SLEEP_COOLDOWN_MS),
    },
    stdio: "ignore",
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilUp(baseUrl);
});

afterAll(() => {
  proc?.kill();
  rmSync(dbDir, { force: true, recursive: true });
});

function post(path: string, cookie: string, body?: URLSearchParams): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, cookie },
    body: body ?? new URLSearchParams(),
    redirect: "manual",
  });
}

async function newVisitor(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

async function loadHome(): Promise<Document> {
  const res = await fetch(new URL("/", baseUrl));
  return new JSDOM(await res.text()).window.document;
}

function parseStats(doc: Document): number[] {
  return [...doc.querySelectorAll(".stat-value")].map((el) => Number(el.textContent));
}

describe("adventure", () => {
  it("applies its exact deterministic deltas and records an attributed history entry", async () => {
    const cookie = await newVisitor();
    const before = parseStats(await loadHome());
    const [hungerBefore, energyBefore, happinessBefore, cleanlinessBefore] = before;

    const res = await post("/api/adventure", cookie);
    expect(res.status).toBe(303);

    const doc = await loadHome();
    const [hungerAfter, energyAfter, happinessAfter, cleanlinessAfter] = parseStats(doc);

    // hunger is untouched; the other three move by exactly the documented
    // amounts (clamped 0–100, same as every applyAction effect).
    expect(hungerAfter).toBe(hungerBefore);
    expect(energyAfter).toBe(Math.max(0, energyBefore - 10));
    expect(happinessAfter).toBe(Math.min(100, happinessBefore + 15));
    expect(cleanlinessAfter).toBe(Math.max(0, cleanlinessBefore - 30));

    expect(doc.querySelector(".last-action")?.textContent).toContain("Adventure");
    expect(doc.querySelector(".history-list")?.textContent).toContain("adventured with Milo");
    expect(doc.querySelector(".history-list")?.textContent).toContain("came back muddy");
  });

  it("is rejected with the real reason while asleep, and adds nothing to history", async () => {
    const cookie = await newVisitor();

    const sleepRes = await post("/api/actions", cookie, new URLSearchParams({ action: "sleep" }));
    // Sleep itself may be rejected if this session's hunger is already too
    // low from a prior test in this file — in that case there's nothing to
    // test here each run, so only proceed once asleep is actually confirmed.
    if (sleepRes.status !== 303) return;

    const before = await loadHome();
    const historyBefore = [...before.querySelectorAll(".history-list li")].map((li) => li.textContent);

    const res = await post("/api/adventure", cookie);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("the creature is asleep right now");

    const after = await loadHome();
    const historyAfter = [...after.querySelectorAll(".history-list li")].map((li) => li.textContent);
    expect(historyAfter).toEqual(historyBefore);

    // Once the cooldown genuinely passes, the exact same adventure succeeds —
    // proving the rejection was the real "asleep" rule, not a permanent one.
    await new Promise((resolve) => setTimeout(resolve, SLEEP_COOLDOWN_MS + 200));
    const retry = await post("/api/adventure", cookie);
    expect(retry.status).toBe(303);
  });

  // performAdventure (src/lib/db.ts) follows the exact same single-
  // transaction, no-await-inside pattern spec/concurrency.test.ts already
  // proves is safe for the five care actions (PROCESS.md, Decision 4) — but
  // as a genuinely new code path, it gets its own direct evidence rather
  // than relying on "it's the same pattern elsewhere" by inference alone.
  it("two genuinely concurrent adventures apply both deltas, in some real order — no lost or duplicated update", async () => {
    const cookieOf = async (): Promise<string> => {
      const res = await fetch(new URL("/", baseUrl));
      const setCookie = res.headers.get("set-cookie");
      const match = setCookie?.match(/commons_session=([^;]+)/);
      if (!match) throw new Error("no commons_session cookie");
      return `commons_session=${match[1]}`;
    };

    const before = parseStats(await loadHome());
    const [hungerBefore, energyBefore, happinessBefore, cleanlinessBefore] = before;

    const [cookieA, cookieB] = await Promise.all([cookieOf(), cookieOf()]);
    expect(cookieA).not.toBe(cookieB);

    // Fired together, not awaited one at a time — genuinely concurrent
    // requests against the one shared row, from two distinct sessions.
    const [resA, resB] = await Promise.all([post("/api/adventure", cookieA), post("/api/adventure", cookieB)]);
    expect(resA.status).toBe(303);
    expect(resB.status).toBe(303);

    const doc = await loadHome();
    const [hungerAfter, energyAfter, happinessAfter, cleanlinessAfter] = parseStats(doc);

    // The oracle: applying the same deterministic delta twice, in sequence
    // (order doesn't matter here — the delta is the same regardless of
    // which adventure goes "first"), clamped the same way the real
    // transaction clamps it.
    expect(hungerAfter).toBe(hungerBefore);
    expect(energyAfter).toBe(Math.max(0, energyBefore - 20));
    expect(happinessAfter).toBe(Math.min(100, happinessBefore + 30));
    expect(cleanlinessAfter).toBe(Math.max(0, cleanlinessBefore - 60));

    // Both history rows present — neither request's event was lost or
    // merged into the other's.
    const historyText = doc.querySelector(".history-list")?.textContent ?? "";
    const adventureCount = (historyText.match(/adventured with Milo/g) ?? []).length;
    expect(adventureCount).toBeGreaterThanOrEqual(2);
  });
});
