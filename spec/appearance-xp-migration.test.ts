import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";

// Regression/migration coverage for `creature.appearance`, `creature.xp`,
// `creature.glasses`, and `care_events.appearance` (PROCESS.md, Decisions
// 15 and 16). Four purely additive `ALTER TABLE ... ADD ...` statements —
// no column-type change, no table rebuild, no hand-written data backfill
// needed (SQLite's own column defaults give every pre-existing row
// appearance='milo'/xp=0 on their own) — but still exercises the two real
// shapes a production database can be in when this migration runs, the
// same standard every other migration test in this repo holds itself to:
// a completely fresh database, and an ALREADY-ROOMED database (post-0005,
// pre-0006) carrying real rooms/creature/sessions/care_events data that
// must survive untouched, with its existing creature row correctly
// starting at appearance='milo' (the only appearance that has ever
// existed until this migration) and xp=0 — never a guessed or
// reconstructed value.

const MIGRATION_TAG = "yielding_thunderball"; // the generated tag of drizzle/0006_*.sql
const workDir = mkdtempSync(join(tmpdir(), "commons-appearance-xp-migration-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe("appearance/xp migration", () => {
  it("adds the new columns, correctly defaulted, on a completely fresh database", () => {
    const dbPath = join(workDir, "fresh.db");
    const client = new Database(dbPath);
    const db = drizzle(client);
    migrate(db, { migrationsFolder: "./drizzle" });

    const creatureColumns = client.prepare("PRAGMA table_info(creature)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const appearance = creatureColumns.find((c) => c.name === "appearance");
    const xp = creatureColumns.find((c) => c.name === "xp");
    const glasses = creatureColumns.find((c) => c.name === "glasses");
    expect(appearance, "expected creature.appearance to exist on a fresh table").toBeDefined();
    expect(appearance?.notnull).toBe(1);
    expect(appearance?.dflt_value).toBe("'milo'");
    expect(xp, "expected creature.xp to exist on a fresh table").toBeDefined();
    expect(xp?.notnull).toBe(1);
    expect(xp?.dflt_value).toBe("0");
    expect(glasses, "expected creature.glasses to exist on a fresh table").toBeDefined();
    expect(glasses?.notnull).toBe(0);

    const careEventColumns = client.prepare("PRAGMA table_info(care_events)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const careAppearance = careEventColumns.find((c) => c.name === "appearance");
    expect(careAppearance, "expected care_events.appearance to exist on a fresh table").toBeDefined();
    expect(careAppearance?.notnull).toBe(1);
    expect(careAppearance?.dflt_value).toBe("'milo'");

    client.close();
  });

  it("backfills an already-roomed database's existing creature row to appearance='milo', xp=0, without touching any other column", () => {
    // Build a pre-this-migration directory (every migration file strictly
    // BEFORE this one, found by journal timestamp position — not by name
    // and not hardcoded as a fixed range — the exact bug class
    // spec/room-migration-backfill.test.ts's own comment documents, and
    // the one spec/log-events-migration.test.ts and spec/milestones-
    // migration.test.ts each had to be fixed for when a later migration
    // landed after them — never repeat that mistake here).
    const migrationsDir = "./drizzle";
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string; when: number }[];
    };
    const thisEntry = journal.entries.find((e) => e.tag.includes(MIGRATION_TAG));
    if (!thisEntry) {
      throw new Error(`could not find the appearance/xp migration (tag containing "${MIGRATION_TAG}") in the journal`);
    }
    const priorEntries = journal.entries.filter((e) => e.when < thisEntry.when);
    expect(priorEntries.length, "expected at least one prior migration to replay").toBeGreaterThan(0);

    const preDir = join(workDir, "drizzle-pre-appearance-xp");
    cpSync(migrationsDir, preDir, { recursive: true });
    const thisFile = readdirSync(preDir).find((f) => f.endsWith(".sql") && f.includes(MIGRATION_TAG));
    if (thisFile) rmSync(join(preDir, thisFile));
    writeFileSync(join(preDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }, null, 2));

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
        `INSERT INTO creature (room_id, hunger, energy, happiness, cleanliness, activity, activity_until, last_action, last_actor_session_id, updated_at, hat, neckwear, total_care_actions)
         VALUES ('ABCD12', 80, 60, 90, 70, 'idle', NULL, 'feed', 's-1', '2026-01-02 00:00:00', 'top-hat', NULL, 12)`,
      )
      .run();
    seedClient
      .prepare(
        `INSERT INTO care_events (session_id, room_id, action, summary, created_at) VALUES ('s-1', 'ABCD12', 'feed', 'fullness +30', '2026-01-02 00:00:00')`,
      )
      .run();
    seedClient.close();

    // Apply the real, full, unmodified migration set.
    const fullClient = new Database(dbPath);
    const fullDb = drizzle(fullClient);
    migrate(fullDb, { migrationsFolder: migrationsDir });

    const row = fullClient.prepare("SELECT * FROM creature WHERE room_id = 'ABCD12'").get() as Record<string, unknown>;
    // The new columns exist and start at the honest, non-fabricated values
    // for a room that predates them: "milo" is the only appearance that
    // has ever existed, and 0 xp is the true starting point (never
    // reconstructed from care_events/log_events, both of which are capped
    // and would under-report once either cap was ever hit).
    expect(row.appearance).toBe("milo");
    expect(row.xp).toBe(0);
    expect(row.glasses).toBeNull();
    // Every pre-existing column is untouched.
    expect(row).toMatchObject({
      hunger: 80,
      energy: 60,
      happiness: 90,
      cleanliness: 70,
      hat: "top-hat",
      neckwear: null,
      total_care_actions: 12,
      last_action: "feed",
      last_actor_session_id: "s-1",
    });

    const careRow = fullClient.prepare("SELECT * FROM care_events WHERE room_id = 'ABCD12'").get() as Record<string, unknown>;
    expect(careRow.appearance).toBe("milo");
    expect(careRow.action).toBe("feed");

    fullClient.close();
  });
});
