import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";

// Regression coverage for two real bugs found in review, before this ever
// shipped: the first draft of drizzle/0003_*.sql's data backfill (a) set
// the legacy COMMONS room's host_session_id to whoever most recently acted
// on the pre-rooms creature — misrepresenting a visitor as the room's
// creator, when the room predates rooms entirely and nobody actually
// hosted it — and (b) backfilled the room's created_at from
// creature.updated_at (overwritten by every mutation, so it would read as
// "now" at migration time), silently resetting Milo's long-accumulated
// displayed age to zero. Both were caught by manually simulating a
// production-shaped database during a ship-readiness review, fixed in the
// migration SQL, and are given their own test here so they can't silently
// regress — see PROCESS.md, Decision 13.
//
// This applies the REAL pre-rooms migrations (every drizzle/*.sql file
// whose tag isn't this app's rooms migration — found by name, not
// hardcoded as "0000-0002", so a future migration added before rooms
// still gets included automatically) against a throwaway database, seeds
// it exactly the way a real pre-rooms deployment would have been seeded,
// then runs the REAL full migration set (including 0003's backfill) via
// the same `migrate()` call src/lib/db.ts uses at boot — never a
// hand-rolled reimplementation of the migration logic. The result is
// checked entirely through the real HTTP surface, never by reading the
// database directly, so this proves what a visitor would actually see.

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

const workDir = mkdtempSync(join(tmpdir(), "commons-migration-backfill-"));
const dbPath = join(workDir, "legacy.db");
const ROOMS_MIGRATION_TAG = "strange_hedge_knight"; // the generated tag of drizzle/0003_*.sql
let proc: ChildProcess | undefined;

afterAll(() => {
  proc?.kill();
  rmSync(workDir, { force: true, recursive: true });
});

describe("room migration backfill (legacy single-creature data)", () => {
  it("backfills the legacy creature into room COMMONS with no false host and the real original age", async () => {
    // Build a pre-rooms-migration directory containing only the real
    // migration files that predate the rooms migration (found by name,
    // not a hardcoded count), with their own matching journal — so
    // applying this folder reproduces the EXACT schema this app had
    // before Decision 13, using the actual committed SQL, not a
    // reimplementation of it.
    const migrationsDir = "./drizzle";
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string; when: number }[];
    };
    const roomsEntry = journal.entries.find((e) => e.tag.includes(ROOMS_MIGRATION_TAG));
    if (!roomsEntry) throw new Error(`could not find the rooms migration (tag containing "${ROOMS_MIGRATION_TAG}") in the journal`);
    // Strictly BEFORE the rooms migration's own timestamp — not just "not
    // named like it." drizzle-kit's migrator tracks "already applied"
    // against the single most recent migration's `when` timestamp, not
    // against which specific migrations ran; a later migration (e.g. one
    // added after rooms, like the log_events migration) left in this set
    // would push that watermark past the rooms migration's own timestamp,
    // causing the real migrator to skip 0003 entirely on the full pass
    // below — a real bug this exact distinction (name vs. position) was
    // written to avoid, found while adding the log_events migration.
    const preRoomsEntries = journal.entries.filter((e) => e.when < roomsEntry.when);
    expect(preRoomsEntries.length, "expected at least one pre-rooms migration to replay").toBeGreaterThan(0);

    const preRoomsDir = join(workDir, "drizzle-pre-rooms");
    cpSync(migrationsDir, preRoomsDir, { recursive: true });
    // Strip the rooms migration's .sql file and its meta/snapshot entries
    // so only the pre-rooms schema gets applied in this first pass.
    const roomsFile = readdirSync(preRoomsDir).find((f) => f.endsWith(".sql") && f.includes(ROOMS_MIGRATION_TAG));
    if (roomsFile) rmSync(join(preRoomsDir, roomsFile));
    writeFileSync(
      join(preRoomsDir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: preRoomsEntries }, null, 2),
    );

    // Apply the real pre-rooms migrations to a fresh database.
    const seedClient = new Database(dbPath);
    const seedDb = drizzle(seedClient);
    migrate(seedDb, { migrationsFolder: preRoomsDir });

    // Seed it exactly the way a real pre-rooms deployment would be: an
    // original visitor's session created long ago, and a SECOND, more
    // recent session that happens to be the creature's last actor —
    // exactly the case that exposed the original bug (the recent actor is
    // NOT who should ever be credited as having "hosted" anything, and
    // must not be read as this room's creation time either).
    const ORIGINAL_VISIT = "2020-01-01 00:00:00"; // deliberately far in the past
    const RECENT_ACTION = "2099-12-31 23:59:59"; // deliberately far in the future
    seedClient
      .prepare("INSERT INTO sessions (id, label, created_at) VALUES (?, ?, ?)")
      .run("s-original", "Original Visitor", ORIGINAL_VISIT);
    seedClient
      .prepare("INSERT INTO sessions (id, label, created_at) VALUES (?, ?, ?)")
      .run("s-recent", "Recent Actor", RECENT_ACTION);
    seedClient
      .prepare(
        `INSERT INTO creature (id, hunger, energy, happiness, cleanliness, activity, activity_until, last_action, last_actor_session_id, updated_at)
         VALUES (1, 100, 100, 100, 90, 'idle', NULL, 'sleep', 's-recent', ?)`,
      )
      .run(RECENT_ACTION);
    seedClient
      .prepare("INSERT INTO care_events (session_id, action, summary) VALUES (?, ?, ?)")
      .run("s-recent", "sleep", "energy → 100, asleep for 8s");
    seedClient.close();

    // Now start the REAL built server against this same database file —
    // it runs src/lib/db.ts's own migrate() call against the FULL,
    // unmodified ./drizzle folder, applying the rooms migration (0003)
    // and its backfill for real, exactly as a production boot would.
    const port = await freePort();
    proc = spawn("node", ["./dist/server/entry.mjs"], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: dbPath },
      stdio: "ignore",
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitUntilUp(baseUrl);

    // Join the legacy room by its known, fixed code and inspect what a
    // real visitor would see — through the HTTP surface, not the database.
    const visit = await fetch(new URL("/", baseUrl));
    const setCookie = visit.headers.get("set-cookie");
    const match = setCookie?.match(/commons_session=([^;]+)/);
    if (!match) throw new Error("no commons_session cookie");
    const cookie = `commons_session=${match[1]}`;

    const joinRes = await fetch(new URL("/api/rooms/join", baseUrl), {
      method: "POST",
      headers: { origin: baseUrl, cookie },
      body: new URLSearchParams({ name: "Tester", roomCode: "COMMONS" }),
      redirect: "manual",
    });
    expect(joinRes.status, "expected the backfilled COMMONS room to exist and be joinable").toBe(303);

    // "?enter=1": the entry page is the default for a bare GET / even for a
    // session that already has a room — see src/pages/index.astro's
    // showEntry comment. This test needs the actual room view (the
    // backfilled stats/history/age it asserts on below).
    const home = await fetch(new URL("/?enter=1", baseUrl), { headers: { cookie } });
    const doc = new JSDOM(await home.text()).window.document;

    // Bug (a): no false host attribution. The recent actor must NOT be
    // credited as having hosted this room — the backfill leaves
    // host_session_id null, so no "Hosted by ..." line renders at all. The
    // recent actor's name legitimately DOES appear elsewhere on the page
    // (Last action / Recent care — they really did perform that sleep),
    // so this only asserts the host-attribution line itself is absent,
    // not that their name never appears anywhere.
    const pageText = doc.body.textContent ?? "";
    expect(pageText, "the legacy room must not claim anyone hosted it").not.toContain("Hosted by");

    // The pre-existing history and stats still came through correctly.
    expect(doc.querySelector(".history-list")?.textContent).toContain("Recent Actor");
    expect(doc.querySelector(".history-list")?.textContent).toContain("put to sleep Milo");
    expect([...doc.querySelectorAll(".stat-value")].map((el) => el.textContent)).toEqual(["100", "100", "100", "90"]);

    // Bug (b): the room's age reflects the ORIGINAL visitor's session, not
    // the recent actor's. formatMiloAge() renders something readable; the
    // concrete assertion that matters is that it's NOT "new"/"today" — it
    // must read as old, derived from the 2020 session, not the 2099 action.
    const ageText = doc.querySelector(".milo-age")?.textContent ?? "";
    expect(ageText.toLowerCase(), `expected an old age derived from the original 2020 session, got "${ageText}"`).not.toMatch(
      /new|today|just/,
    );
  });
});
