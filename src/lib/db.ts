import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { type ActionName, type Activity, type Stats, applyAction, deriveHealth, resolveActivity } from "./creature";
import { creature, type Creature } from "./schema";

// One SQLite file is the app's whole persistent state. fly.toml mounts a
// volume at /data (fixed, not to be touched); the Dockerfile points
// DATABASE_PATH at it, which is how state survives a reload, a restart and
// a redeploy. Locally it defaults to an untracked file in .data/.
const path = process.env.DATABASE_PATH ?? "./.data/app.db";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path);
client.pragma("journal_mode = WAL");

export const db = drizzle(client);
type Db = typeof db;
// What both `db` and the handle `db.transaction()` hands its callback have
// in common — enough to read the creature row either outside or inside a
// transaction with the same function.
type Queryable = Pick<Db, "select">;

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

// There is exactly one creature, always at this id. Every query below reads
// or writes this one row — see PROCESS.md for why one shared creature
// (not one per user) is the whole point of COMMONS.
const CREATURE_ID = 1;

function seedIfEmpty(): void {
  const existing = db.select({ id: creature.id }).from(creature).where(eq(creature.id, CREATURE_ID)).get();
  if (existing !== undefined) return;
  // A fresh creature starts comfortably in the middle of every need, not at
  // the extremes — there's something for a first visitor to improve, but
  // nothing urgent.
  db.insert(creature)
    .values({
      id: CREATURE_ID,
      hunger: 70,
      energy: 70,
      happiness: 70,
      cleanliness: 70,
      activity: "idle",
      activityUntil: null,
      lastAction: null,
    })
    .run();
}
seedIfEmpty();

function readRow(handle: Queryable): Creature {
  const row = handle.select().from(creature).where(eq(creature.id, CREATURE_ID)).get();
  if (!row) throw new Error("creature row missing after seed — this should never happen");
  return row;
}

export interface CreatureState {
  stats: Stats;
  health: number;
  activity: Activity;
  activityUntil: string | null;
  lastAction: string | null;
  updatedAt: string;
}

function toState(row: Creature): CreatureState {
  const resolved = resolveActivity(
    { stats: row, activity: row.activity as Activity, activityUntil: row.activityUntil },
    new Date(),
  );
  return {
    stats: row,
    health: deriveHealth(row),
    activity: resolved.activity,
    activityUntil: resolved.activityUntil,
    lastAction: row.lastAction,
    updatedAt: row.updatedAt,
  };
}

// Always a fresh read from SQLite — never from anything held in a variable
// across requests (see CLAUDE.md).
export function getCreatureState(): CreatureState {
  return toState(readRow(db));
}

export type ActionRejection = { reason: string };

// Applies one action inside a single synchronous transaction: read the
// current row, resolve any expired sleep, validate, compute the new state,
// write it back — all without an `await` anywhere in between, which is what
// makes two concurrent requests resolve deterministically in arrival order
// rather than racing each other (see PROCESS.md, Decision 4).
export function performAction(action: ActionName): CreatureState | ActionRejection {
  return db.transaction((tx) => {
    const row = readRow(tx);
    const now = new Date();
    const resolved = resolveActivity(
      { stats: row, activity: row.activity as Activity, activityUntil: row.activityUntil },
      now,
    );
    const outcome = applyAction(action, resolved, now);
    if (!outcome.ok) return { reason: outcome.reason };

    tx.update(creature)
      .set({
        ...outcome.result.stats,
        activity: outcome.result.activity,
        activityUntil: outcome.result.activityUntil,
        lastAction: action,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, CREATURE_ID))
      .run();

    return toState(readRow(tx));
  });
}
