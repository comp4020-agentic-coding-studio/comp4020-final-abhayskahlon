import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

async function listenOnFreePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitFor(baseUrl: string, attempts: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (attempt >= attempts) {
      throw new Error(`nothing is answering at ${baseUrl}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// The spec checks a RUNNING app over HTTP, so it holds whatever the app is
// built with. When APP_URL is already set, something external started the
// app and points at it — in CI that's the built Docker image (the same
// artefact Fly deploys), so this just waits for it. Locally, with no
// APP_URL, this spawns the BUILT server itself (`pnpm test` builds first) on
// a free port with a throwaway database, so `pnpm check` works without a
// container. Either way nothing here ever depends on a developer's own
// data: a fresh clone and a fresh `pnpm test` always start from an empty
// creature, seeded the same way boot always seeds it (see src/lib/db.ts).
export default async function setup(project: TestProject): Promise<(() => void) | void> {
  if (process.env.APP_URL) {
    const baseUrl = process.env.APP_URL;
    // some stacks take a while to boot or migrate
    await waitFor(baseUrl, 300);
    project.provide("baseUrl", baseUrl);
    return;
  }

  const entry = "./dist/server/entry.mjs";
  if (!existsSync(entry)) {
    throw new Error(`${entry} not found — run \`pnpm test\`, which builds first`);
  }

  const port = await listenOnFreePort();
  const server = spawn("node", [entry], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "commons-spec-db-")), "test.db"),
      // Test-only seam, shortening the real sleep cooldown (src/lib/creature.ts)
      // so a local `pnpm test` run doesn't sit through it for real. Never set
      // in fly.toml or the Dockerfile — a production boot always uses the
      // real default.
      SLEEP_COOLDOWN_MS: "300",
    },
    stdio: "ignore",
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(baseUrl, 50);
  } catch (err) {
    server.kill();
    throw err;
  }

  project.provide("baseUrl", baseUrl);
  return () => {
    server.kill();
  };
}
