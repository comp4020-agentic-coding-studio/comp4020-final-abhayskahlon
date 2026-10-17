import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";

// Regression/migration coverage for the log_events table added alongside
// PROCESS.md, Decision 13's log-retention follow-up (drizzle/0004_*.sql).
// Unlike the rooms migration (drizzle/0003_*.sql), this one is purely
// additive — a single CREATE TABLE, no column-type changes, no table
// rebuild, no data backfill — so its own migration test is simpler than
// spec/room-migration-backfill.test.ts, but still exercises the two real
// shapes a production database can be in when this migration runs: a
// completely fresh database, and an ALREADY-ROOMED database (post-0003,
// pre-0004) carrying real rooms/creature/sessions/care_events data that
// must survive untouched.

const LOG_EVENTS_MIGRATION_TAG = "true_madame_web"; // the generated tag of drizzle/0004_*.sql
const workDir = mkdtempSync(join(tmpdir(), "commons-log-events-migration-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe("log_events migration", () => {
  it("creates an empty log_events table on a completely fresh database", () => {
    const dbPath = join(workDir, "fresh.db");
    const client = new Database(dbPath);
    const db = drizzle(client);
    migrate(db, { migrationsFolder: "./drizzle" });

    const rows = client.prepare("SELECT * FROM log_events").all();
    expect(rows).toEqual([]);

    const columns = client.prepare("PRAGMA table_info(log_events)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name).sort();
    expect(columnNames).toEqual(["action", "actor", "created_at", "event_type", "id", "outcome", "reason", "room_id"].sort());

    client.close();
  });

  it("adds log_events to an already-roomed database without touching its existing data", () => {
    // Build a pre-log_events directory (every migration file except the
    // log_events one, found by name — not hardcoded as "0000-0003", so a
    // future migration added before this one is still picked up
    // automatically), apply it to a fresh database, seed it with real
    // room/creature/session/care_events data (a database shaped exactly
    // like production immediately after the rooms migration, before this
    // one), then apply the REAL full migration set and confirm every
    // existing row survived untouched.
    const migrationsDir = "./drizzle";
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string }[];
    };
    const preLogEventsEntries = journal.entries.filter((e) => !e.tag.includes(LOG_EVENTS_MIGRATION_TAG));
    expect(preLogEventsEntries.length, "expected at least one pre-log_events migration to replay").toBeGreaterThan(0);

    const preDir = join(workDir, "drizzle-pre-log-events");
    cpSync(migrationsDir, preDir, { recursive: true });
    const logEventsFile = readdirSync(preDir).find((f) => f.endsWith(".sql") && f.includes(LOG_EVENTS_MIGRATION_TAG));
    if (logEventsFile) rmSync(join(preDir, logEventsFile));
    writeFileSync(join(preDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: preLogEventsEntries }, null, 2));

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
    seedClient
      .prepare("INSERT INTO care_events (session_id, room_id, action, summary) VALUES (?, ?, ?, ?)")
      .run("s-1", "ABCD12", "feed", "fullness +30, happiness +5, cleanliness −5");
    seedClient.close();

    // Apply the real, full, unmodified migration set — this is what
    // actually matters: that 0004 alone (a plain CREATE TABLE) runs
    // cleanly against a database that already has 0000-0003 applied and
    // real data in it, without disturbing any of that data.
    const fullClient = new Database(dbPath);
    const fullDb = drizzle(fullClient);
    migrate(fullDb, { migrationsFolder: migrationsDir });

    // Every pre-existing row is untouched.
    expect(fullClient.prepare("SELECT * FROM rooms WHERE id = 'ABCD12'").get()).toMatchObject({
      id: "ABCD12",
      host_session_id: null,
      created_at: "2026-01-01 00:00:00",
    });
    expect(fullClient.prepare("SELECT * FROM sessions WHERE id = 's-1'").get()).toMatchObject({
      id: "s-1",
      label: "Existing Visitor",
      room_id: "ABCD12",
    });
    expect(fullClient.prepare("SELECT * FROM creature WHERE room_id = 'ABCD12'").get()).toMatchObject({
      hunger: 80,
      energy: 60,
      happiness: 90,
      cleanliness: 70,
      last_action: "feed",
      last_actor_session_id: "s-1",
    });
    expect(fullClient.prepare("SELECT * FROM care_events WHERE room_id = 'ABCD12'").get()).toMatchObject({
      session_id: "s-1",
      room_id: "ABCD12",
      action: "feed",
    });

    // And the new table exists, empty — nothing in this migration writes
    // retroactive log_events rows for pre-existing care_events history;
    // it only starts recording events from this point forward.
    expect(fullClient.prepare("SELECT * FROM log_events").all()).toEqual([]);

    fullClient.close();
  });
});
