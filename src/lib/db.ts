import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { desc, eq, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { type ActionName, type Activity, type Stats, applyAction, deriveHealth, resolveActivity } from "./creature";
import { type CareEvent, type Creature, type Session, careEvents, creature, sessions } from "./schema";

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
// What `db` and the handle `db.transaction()` hands its callback have in
// common — enough to read, write and prune either outside or inside a
// transaction with the same functions.
type Handle = Pick<Db, "select" | "insert" | "update" | "delete">;

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

// There is exactly one creature, always at this id. Every query below reads
// or writes this one row — see PROCESS.md for why one shared creature
// (not one per user) is the whole point of COMMONS.
const CREATURE_ID = 1;

// A small, deliberate bound (PROCESS.md, Decision 8) — not unlimited, and
// not an accident discovered later.
const CARE_HISTORY_LIMIT = 50;
// How many of that history the UI actually renders at once; the database
// still keeps CARE_HISTORY_LIMIT regardless of this.
const CARE_HISTORY_DISPLAY = 8;

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
      lastActorSessionId: null,
    })
    .run();
}
seedIfEmpty();

function readRow(handle: Handle): Creature {
  const row = handle.select().from(creature).where(eq(creature.id, CREATURE_ID)).get();
  if (!row) throw new Error("creature row missing after seed — this should never happen");
  return row;
}

// ---- sessions: a lightweight, unauthenticated visitor identity ------------
// src/lib/session.ts owns the cookie; this is just the persistence. See
// PROCESS.md, Decision 7 — no login, no account, never shared across
// browsers.

export function findSession(id: string): Session | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function createSession(id: string, label: string): Session {
  return db.insert(sessions).values({ id, label }).returning().get();
}

export function touchSession(id: string): void {
  db.update(sessions).set({ lastSeenAt: sql`(datetime('now'))` }).where(eq(sessions.id, id)).run();
}

// ---- creature state, including the (joined) view the UI renders ----------

export interface CareHistoryEntry {
  action: string;
  summary: string;
  actorLabel: string;
  createdAt: string;
}

export interface CreatureState {
  stats: Stats;
  health: number;
  activity: Activity;
  activityUntil: string | null;
  lastAction: string | null;
  lastActorLabel: string | null;
  updatedAt: string;
  history: CareHistoryEntry[];
}

function listRecentCareHistory(handle: Handle, limit: number): CareHistoryEntry[] {
  return handle
    .select({
      action: careEvents.action,
      summary: careEvents.summary,
      actorLabel: sessions.label,
      createdAt: careEvents.createdAt,
    })
    .from(careEvents)
    .innerJoin(sessions, eq(careEvents.sessionId, sessions.id))
    .orderBy(desc(careEvents.id))
    .limit(limit)
    .all();
}

function toState(handle: Handle, row: Creature): CreatureState {
  const resolved = resolveActivity(
    { stats: row, activity: row.activity as Activity, activityUntil: row.activityUntil },
    new Date(),
  );
  const lastActor = row.lastActorSessionId
    ? handle.select({ label: sessions.label }).from(sessions).where(eq(sessions.id, row.lastActorSessionId)).get()
    : undefined;
  return {
    stats: row,
    health: deriveHealth(row),
    activity: resolved.activity,
    activityUntil: resolved.activityUntil,
    lastAction: row.lastAction,
    lastActorLabel: lastActor?.label ?? null,
    updatedAt: row.updatedAt,
    history: listRecentCareHistory(handle, CARE_HISTORY_DISPLAY),
  };
}

// Always a fresh read from SQLite — never from anything held in a variable
// across requests (see CLAUDE.md).
export function getCreatureState(): CreatureState {
  return toState(db, readRow(db));
}

// Deletes every care_events row beyond the most recent CARE_HISTORY_LIMIT.
// Called after every successful action, inside the same transaction, so the
// table never grows past the bound PROCESS.md Decision 8 commits to.
function pruneCareHistory(handle: Handle): void {
  const keep = handle.select({ id: careEvents.id }).from(careEvents).orderBy(desc(careEvents.id)).limit(CARE_HISTORY_LIMIT).all();
  if (keep.length < CARE_HISTORY_LIMIT) return; // nothing to prune yet
  handle
    .delete(careEvents)
    .where(
      notInArray(
        careEvents.id,
        keep.map((row) => row.id),
      ),
    )
    .run();
}

export type ActionRejection = { reason: string };

// Applies one action inside a single synchronous transaction: read the
// current row, resolve any expired sleep, validate, compute the new state,
// write it back, record who did it — all without an `await` anywhere in
// between, which is what makes two concurrent requests resolve
// deterministically in arrival order rather than racing each other (see
// PROCESS.md, Decision 4). A rejected action touches nothing: no stats
// change, no care_events row, no last-actor update.
export function performAction(action: ActionName, sessionId: string): CreatureState | ActionRejection {
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
        lastActorSessionId: sessionId,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, CREATURE_ID))
      .run();

    tx.insert(careEvents).values({ sessionId, action, summary: outcome.result.summary }).run();
    pruneCareHistory(tx);

    return toState(tx, readRow(tx));
  });
}

export type { CareEvent, Session };
