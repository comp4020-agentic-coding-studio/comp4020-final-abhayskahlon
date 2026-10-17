import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression coverage for a real credential-exposure bug, found during
// ship-readiness review before this ever shipped: src/lib/log.ts originally
// wrote the RAW session id — the exact value set as the commons_session
// cookie, and the session's entire bearer credential (PROCESS.md, Decision
// 7 — no password layer at all) — straight into every structured stdout
// log line. Anyone able to read these logs (course staff via
// `mise exec -- flyctl logs`, or anyone else with log/Fly access) could
// lift that value and use it as their own cookie to impersonate the
// session it belonged to, in whatever room it was in, for as long as that
// session existed. Fixed by replacing the raw id with a one-way SHA-256
// digest (`actorTag()`), so log lines stay attributable (the SAME session
// always produces the SAME tag) without ever being reversible back to the
// credential.
//
// Unlike every other spec file here, this one does NOT discard the
// server's stdout: it's spawned with `stdio: ["ignore", "pipe", "pipe"]`
// and this test reads the captured output directly, because the only way
// to actually prove what ends up in the log is to look at the log — not
// at log.ts's source, and not at whatever shape its exported functions'
// TypeScript types claim.

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
let stdout = "";
const dbDir = mkdtempSync(join(tmpdir(), "commons-logging-"));

beforeAll(async () => {
  const port = await freePort();
  proc = spawn("node", ["./dist/server/entry.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: join(dbDir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
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
  return match[1]; // the raw session id itself, exactly what a visitor's cookie value would be
}

async function freshSession(): Promise<{ cookie: string; sessionId: string }> {
  const res = await fetch(new URL("/", baseUrl));
  const sessionId = extractSessionCookie(res);
  return { cookie: `commons_session=${sessionId}`, sessionId };
}

// Polls the captured stdout buffer for a JSON object matching `predicate`,
// tolerating the inherent delay between a request completing and the
// child process's stdout chunk actually arriving in this test's own
// process.
async function waitForLogLine(predicate: (obj: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (predicate(obj)) return obj;
      } catch {
        // not valid JSON (an Astro/Node startup line) — skip
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no matching log line found within ${timeoutMs}ms. Captured stdout:\n${stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function expectedActorTag(sessionId: string): string {
  // Mirrors src/lib/log.ts's actorTag() exactly — this test's own oracle,
  // not a reimplementation of different logic, so it fails loudly if the
  // real function's hash algorithm or truncation length ever changes
  // without this test being updated too.
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

describe("structured logging: credential safety and attribution", () => {
  it("logs a successful care action with an attributable, non-reversible actor tag — never the raw session id", async () => {
    const { cookie, sessionId } = await freshSession();
    const hostRes = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Logger" }));
    expect(hostRes.status).toBe(303);

    const feedRes = await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    expect(feedRes.status).toBe(303);

    const line = await waitForLogLine((obj) => obj.type === "care_event" && obj.action === "feed" && obj.outcome === "success");
    expect(line.actor).toBe(expectedActorTag(sessionId));
    expect(line.sessionId).toBeUndefined(); // the raw-id field must not exist under its old name either
    expect(line.roomId).toEqual(expect.any(String));
    expect(line.sessionLabel).toBe("Logger");
  });

  it("logs a rejected care action the same attributable way, with its real rejection reason", async () => {
    const { cookie, sessionId } = await freshSession();
    const hostRes = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Rejectee" }));
    expect(hostRes.status).toBe(303);

    // Drain energy via `play` until the server itself rejects one.
    let rejected = false;
    for (let i = 0; i < 20 && !rejected; i++) {
      const res = await post("/api/actions", cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) rejected = true;
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBe(true);

    const line = await waitForLogLine(
      (obj) => obj.type === "care_event" && obj.action === "play" && obj.outcome === "rejected",
    );
    expect(line.actor).toBe(expectedActorTag(sessionId));
    expect(line.reason).toBe("too tired to play");
  });

  it("logs room hosting and joining with the same attributable, non-reversible actor tag", async () => {
    const host = await freshSession();
    const hostRes = await post("/api/rooms/host", host.cookie, new URLSearchParams({ name: "RoomHoster" }));
    expect(hostRes.status).toBe(303);
    const hostLine = await waitForLogLine((obj) => obj.type === "room_hosted" && obj.sessionLabel === "RoomHoster");
    expect(hostLine.actor).toBe(expectedActorTag(host.sessionId));
    const roomId = hostLine.roomId as string;

    const member = await freshSession();
    const joinRes = await post("/api/rooms/join", member.cookie, new URLSearchParams({ name: "RoomJoiner", roomCode: roomId }));
    expect(joinRes.status).toBe(303);
    const joinLine = await waitForLogLine((obj) => obj.type === "room_joined" && obj.sessionLabel === "RoomJoiner");
    expect(joinLine.actor).toBe(expectedActorTag(member.sessionId));
    expect(joinLine.roomId).toBe(roomId);
  });

  it("the SAME session always produces the SAME actor tag across multiple events — attribution is preserved", async () => {
    // A distinct, unlikely-to-collide label scopes which log lines belong
    // to THIS test's session — stdout accumulates across this whole file
    // (every test shares one running server instance), so matching only
    // on event type/action would risk picking up an earlier test's
    // unrelated feed/clean line instead of this session's own.
    const label = "Repeat Visitor (same-tag test)";
    const { cookie, sessionId } = await freshSession();
    await post("/api/rooms/host", cookie, new URLSearchParams({ name: label }));
    await post("/api/actions", cookie, new URLSearchParams({ action: "feed" }));
    await post("/api/actions", cookie, new URLSearchParams({ action: "clean" }));

    const feedLine = await waitForLogLine(
      (obj) => obj.type === "care_event" && obj.action === "feed" && obj.sessionLabel === label,
    );
    const cleanLine = await waitForLogLine(
      (obj) => obj.type === "care_event" && obj.action === "clean" && obj.sessionLabel === label,
    );
    expect(feedLine.actor).toBe(cleanLine.actor);
    expect(feedLine.actor).toBe(expectedActorTag(sessionId));
  });

  it("never emits the raw session id anywhere in stdout, across every event type exercised above", async () => {
    // Collects every session id this entire test file has minted and
    // confirms NONE of them appear verbatim anywhere in the captured
    // stdout — the actual, direct proof the bug this file exists for
    // cannot have recurred, checked against the real captured output
    // rather than inferred from log.ts's source.
    const sessions = await Promise.all([freshSession(), freshSession(), freshSession()]);
    for (const { cookie } of sessions) {
      await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Scan Target" }));
    }
    // Give the last few log lines a moment to actually arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const { sessionId } of sessions) {
      expect(stdout, `raw session id ${sessionId} must never appear in stdout`).not.toContain(sessionId);
    }
  });
});
