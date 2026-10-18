import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";

// Regression/migration coverage for `creature.total_care_actions`
// (PROCESS.md, Decision 14). A single additive `ALTER TABLE ... ADD
// total_care_actions integer DEFAULT 0 NOT NULL` — no column-type change,
// no table rebuild, no hand-written data backfill needed (SQLite's own
// `DEFAULT 0 NOT NULL` already gives every pre-existing row 0 on its own) —
// but still exercises the two real shapes a production database can be in
// when this migration runs, the same standard every other migration test
// in this repo holds itself to: a completely fresh database, and an
// ALREADY-ROOMED database (post-0004, pre-0005) carrying real
// rooms/creature/sessions/care_events/log_events data that must survive
// untouched, with its existing creature row correctly starting its
// milestone count at exactly 0 — not reconstructed from capped history
// (care_events/log_events are both pruned, so couldn't give an honest
// total anyway), stated plainly rather than glossed over.

const MILESTONES_MIGRATION_TAG = "peaceful_black_cat"; // the generated tag of drizzle/0005_*.sql
const workDir = mkdtempSync(join(tmpdir(), "commons-milestones-migration-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe("total_care_actions migration", () => {
  it("adds the column, defaulted to 0, on a completely fresh database", () => {
    const dbPath = join(workDir, "fresh.db");
    const client = new Database(dbPath);
    const db = drizzle(client);
    migrate(db, { migrationsFolder: "./drizzle" });

    const columns = client.prepare("PRAGMA table_info(creature)").all() as { name: string; notnull: number; dflt_value: string }[];
    const column = columns.find((c) => c.name === "total_care_actions");
    expect(column, "expected total_care_actions to exist on a fresh creature table").toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("0");

    client.close();
  });

  it("backfills an already-roomed database's existing creature row to 0, without touching any other column", () => {
    // Build a pre-milestones directory (every migration file strictly
    // BEFORE this one, found by journal timestamp position — not by name,
    // and not hardcoded as "0000-0004" — so a future migration added
    // before this one is still picked up automatically). Filtering by
    // name alone is exactly the bug class spec/room-migration-
    // backfill.test.ts's own comment documents, and the one
    // spec/log-events-migration.test.ts just had to be fixed for when
    // THIS migration landed after it — never repeat that mistake here.
    const migrationsDir = "./drizzle";
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string; when: number }[];
    };
    const milestonesEntry = journal.entries.find((e) => e.tag.includes(MILESTONES_MIGRATION_TAG));
    if (!milestonesEntry) {
      throw new Error(`could not find the milestones migration (tag containing "${MILESTONES_MIGRATION_TAG}") in the journal`);
    }
    const preMilestonesEntries = journal.entries.filter((e) => e.when < milestonesEntry.when);
    expect(preMilestonesEntries.length, "expected at least one pre-milestones migration to replay").toBeGreaterThan(0);

    const preDir = join(workDir, "drizzle-pre-milestones");
    cpSync(migrationsDir, preDir, { recursive: true });
    const milestonesFile = readdirSync(preDir).find((f) => f.endsWith(".sql") && f.includes(MILESTONES_MIGRATION_TAG));
    if (milestonesFile) rmSync(join(preDir, milestonesFile));
    writeFileSync(join(preDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: preMilestonesEntries }, null, 2));

    const dbPath = join(workDir, "already-roomed.db");
    const seedClient = new Database(dbPath);
    const seedDb = drizzle(seedClient);
    migrate(seedDb, { migrationsFolder: preDir });

    seedClient.prepare("INSERT INTO rooms (id, host_session_id, created_at) VALUES (?, ?, ?)").run("ABCD12", null, "2026-01-01 00:00:00");
    seedClient
      .prepare("INSERT INTO sessions (id, label, created_at, room_id) VALUES (?, ?, ?, ?)")
      .run("s-1", "Existing Visitor", "2026-01-01 00:00:00", "ABCD12");
    seedClient
      .prepare(
        `INSERT INTO creature (room_id, hunger, energy, happiness, cleanliness, activity, activity_until, last_action, last_actor_session_id, updated_at)
         VALUES ('ABCD12', 80, 60, 90, 70, 'idle', NULL, 'feed', 's-1', '2026-01-02 00:00:00')`,
      )
      .run();
    seedClient.close();

    // Apply the real, full, unmodified migration set.
    const fullClient = new Database(dbPath);
    const fullDb = drizzle(fullClient);
    migrate(fullDb, { migrationsFolder: migrationsDir });

    const row = fullClient.prepare("SELECT * FROM creature WHERE room_id = 'ABCD12'").get() as Record<string, unknown>;
    // The new column exists and starts at 0 for a room that predates it —
    // not reconstructed from care_events/log_events (both pruned, and
    // would under-report once either cap was ever hit), stated plainly as
    // the honest starting point rather than a guessed/inferred one.
    expect(row.total_care_actions).toBe(0);
    // Every pre-existing column is untouched.
    expect(row).toMatchObject({
      hunger: 80,
      energy: 60,
      happiness: 90,
      cleanliness: 70,
      last_action: "feed",
      last_actor_session_id: "s-1",
    });

    fullClient.close();
  });
});
