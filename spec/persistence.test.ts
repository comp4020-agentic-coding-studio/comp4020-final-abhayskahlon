import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// This needs its own app instance, separate from the one spec/global-setup.ts
// shares across every other spec file: it has to kill and restart the
// server against the SAME database file to prove the care history and last
// actor survive that — not just survive another request to an app that
// never stopped running.

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(baseUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (attempt >= 100) throw new Error(`nothing answering at ${baseUrl}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startApp(databasePath: string): Promise<{ baseUrl: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn("node", ["./dist/server/entry.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: databasePath },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilUp(baseUrl);
  return { baseUrl, proc };
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

describe("persistence across a restart", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "commons-persistence-")), "test.db");
  let runningProc: ChildProcess | undefined;

  afterAll(() => {
    runningProc?.kill();
    rmSync(dbPath, { force: true, recursive: true });
  });

  it("keeps the care history and last actor after the process restarts", async () => {
    const first = await startApp(dbPath);
    runningProc = first.proc;

    const visit = await fetch(new URL("/", first.baseUrl));
    const cookie = extractSessionCookie(visit);

    const act = await fetch(new URL("/api/actions", first.baseUrl), {
      method: "POST",
      headers: { origin: first.baseUrl, cookie },
      body: new URLSearchParams({ action: "feed" }),
      redirect: "manual",
    });
    expect(act.status).toBe(303);

    const beforeRestart = await (await fetch(new URL("/", first.baseUrl), { headers: { cookie } })).text();
    expect(beforeRestart).toContain("fed the creature");

    first.proc.kill();
    // give the OS a moment to release the file lock before the next
    // process opens the same SQLite file
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await startApp(dbPath);
    runningProc = second.proc;

    const afterRestart = await (await fetch(new URL("/", second.baseUrl), { headers: { cookie } })).text();
    expect(afterRestart).toContain("fed the creature");

    second.proc.kill();
  });
});
