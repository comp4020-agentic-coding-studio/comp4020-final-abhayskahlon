import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression coverage for a reported inconsistency: a human playtest saw
// the activity badge read "awake" while an action attempt was still
// rejected, with the generic fallback error message. Extensive targeted
// reproduction (five trials polling right at the exact cooldown boundary;
// every distinct rejection reason checked for content-type; multipart
// FormData bodies, matching what the real client actually sends, not just
// url-encoded; Astro's own CSRF-rejection response; res.redirected checked
// against the real production deployment) never found a case where the
// GET/render path and the POST/validate path actually disagreed — both
// call the same resolveActivity logic, freshly, every time. What WAS real:
// the stored row was never corrected to match once resolved, only ever
// recomputed transiently — src/lib/db.ts's resolveAndSync now closes that
// gap, and this proves the consistency property it exists for, end to end
// against the real app rather than the pure function in isolation.
//
// Own app instance (not the one spec/global-setup.ts shares) so
// SLEEP_COOLDOWN_MS can be overridden short without affecting any other
// spec file's timing.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-activity-"));

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

function post(path: string, cookie: string, body: URLSearchParams): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, cookie },
    body,
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

describe("activity resolution consistency", () => {
  it("validates an action as awake the moment the sleep cooldown has passed, with no GET in between", async () => {
    const cookie = await newVisitor();

    const sleepRes = await post("/api/actions", cookie, new URLSearchParams({ action: "sleep" }));
    expect(sleepRes.status).toBe(303);

    await new Promise((resolve) => setTimeout(resolve, SLEEP_COOLDOWN_MS + 200));

    // No GET / in between — straight to the POST/validate path, proving it
    // independently resolves the expired cooldown correctly rather than
    // relying on some earlier read having already done so.
    const feedRes = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(feedRes.status, "feed should succeed once the cooldown has genuinely passed").toBe(303);
  });

  it("names the actual applicable rule, never an asleep-related one, once the cooldown has passed", async () => {
    const cookie = await newVisitor();

    // Drain hunger across as many sleep/play cycles as it takes — robust
    // regardless of whatever hunger this shared instance already happens
    // to be at from the previous test in this file, rather than assuming
    // a fresh seed. Each cycle: sleep (to guarantee full energy for
    // draining; a 303 restarts the cooldown, a 409 "already asleep" just
    // means a previous cycle's sleep is still running down — either way
    // waiting the cooldown out is correct), wait it out, then drain via
    // `play` (happiness up, hunger and energy down) until energy runs out.
    let finalStatus: number | undefined;
    let finalReason: string | undefined;
    for (let cycle = 0; cycle < 10; cycle++) {
      await post("/api/actions", cookie, new URLSearchParams({ action: "sleep" }));
      await new Promise((resolve) => setTimeout(resolve, SLEEP_COOLDOWN_MS + 200));

      for (let i = 0; i < 8; i++) {
        await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      }

      const attempt = await post("/api/actions", cookie, new URLSearchParams({ action: "sleep" }));
      finalStatus = attempt.status;
      finalReason = await attempt.text();
      if (finalStatus === 409 && finalReason === "too hungry to sleep") break;
    }

    expect(finalStatus, "expected sleep to eventually be rejected for being too hungry").toBe(409);
    // The key assertion: once genuinely awake, a sleep attempt rejected
    // for being too hungry must say so — never "already asleep", which
    // would mean validation still (wrongly) thought it was asleep.
    expect(finalReason).not.toBe("already asleep");
    expect(finalReason).toBe("too hungry to sleep");
  });
});
