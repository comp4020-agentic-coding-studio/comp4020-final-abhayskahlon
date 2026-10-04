import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Turns this milestone's spec lines into checks: a connected client gets an
// "update" event once another session's action commits, a rejected action
// produces no event at all, several connected clients all see the same
// update, and the event payload itself can never become a second copy of
// creature state.
//
// This spins up its OWN app instance rather than using the one
// spec/global-setup.ts shares with every other spec file: these tests
// assert on short "nothing arrived in N ms" windows, and another spec
// file's actions landing on a shared app mid-window would make that flaky
// in a way no amount of retrying fixes — the same reason
// spec/persistence.test.ts owns its own instance.

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
const dbDir = mkdtempSync(join(tmpdir(), "commons-realtime-"));

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

async function newVisitor(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return extractSessionCookie(res);
}

interface SseEvent {
  event: string;
  data: string;
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat, never "the" event
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && event === "message") return null; // pure comment block
  return { event, data: dataLines.join("\n") };
}

// A small SSE client built on a single background read loop (never more
// than one `reader.read()` in flight at a time — calling it again before
// the previous call resolves isn't allowed), so `next(timeoutMs)` can be
// called any number of times and just waits on a queue fed by that loop.
function connectEvents(): { next: (timeoutMs: number) => Promise<SseEvent | null>; close: () => void } {
  const controller = new AbortController();
  const queue: SseEvent[] = [];
  const waiters: (() => void)[] = [];
  let closed = false;

  const ready = fetch(new URL("/api/events", baseUrl), { signal: controller.signal }).then((res) => {
    if (!res.ok || !res.body) throw new Error(`could not open SSE stream: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const parsed = parseBlock(buffer.slice(0, sep));
            buffer = buffer.slice(sep + 2);
            if (parsed) {
              queue.push(parsed);
              waiters.shift()?.();
            }
          }
        }
      } catch {
        // aborted/closed — fine, next() below just stops waiting
      } finally {
        closed = true;
        for (const w of waiters.splice(0)) w();
      }
    })();
  });

  async function next(timeoutMs: number): Promise<SseEvent | null> {
    await ready;
    if (queue.length > 0) return queue.shift()!;
    if (closed) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return queue.length > 0 ? queue.shift()! : null;
  }

  return { next, close: () => controller.abort() };
}

describe("real-time updates", () => {
  it("a connected client receives an update after another session's action commits", async () => {
    const events = connectEvents();
    try {
      const cookie = await newVisitor();
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(res.status).toBe(303);

      const event = await events.next(2000);
      expect(event?.event).toBe("update");
    } finally {
      events.close();
    }
  });

  it("a rejected action produces no update event", async () => {
    const cookie = await newVisitor();
    // Drain energy via `play` until the server itself rejects one —
    // deterministic regardless of state left over from earlier tests in
    // this file, since a rejection never changes state (so once rejected,
    // it stays rejected).
    let rejected = false;
    for (let i = 0; i < 20 && !rejected; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) rejected = true;
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBe(true);

    const events = connectEvents();
    try {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      expect(res.status).toBe(409);

      // A short window, proving absence rather than presence.
      const silence = await events.next(700);
      expect(silence).toBeNull();

      // Sanity check the connection is actually alive, not coincidentally
      // silent: a real action right after should still produce an event.
      const okRes = await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));
      expect(okRes.status).toBe(303);
      const confirmed = await events.next(2000);
      expect(confirmed?.event).toBe("update");
    } finally {
      events.close();
    }
  });

  it("multiple connected clients all receive the same update", async () => {
    const a = connectEvents();
    const b = connectEvents();
    try {
      const cookie = await newVisitor();
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
      expect(res.status).toBe(303);

      const [eventA, eventB] = await Promise.all([a.next(2000), b.next(2000)]);
      expect(eventA?.event).toBe("update");
      expect(eventB?.event).toBe("update");
    } finally {
      a.close();
      b.close();
    }
  });

  it("the event carries no creature state — a signal to re-fetch, never a second copy of it", async () => {
    const events = connectEvents();
    try {
      const cookie = await newVisitor();
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "walk" }));
      expect(res.status).toBe(303);

      const event = await events.next(2000);
      expect(event?.event).toBe("update");
      // If this payload ever started carrying fields like hunger/energy, a
      // client could render straight from the event and silently drift
      // from SQLite (see PROCESS.md, Decision 5) — so it must stay empty.
      expect(event?.data).not.toMatch(/hunger|energy|happiness|cleanliness|stats/i);
      expect(JSON.parse(event?.data ?? "null")).toEqual({});
    } finally {
      events.close();
    }
  });
});
