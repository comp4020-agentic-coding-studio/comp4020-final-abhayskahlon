import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { desc, eq, min, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  type ActionName,
  type Activity,
  type HatOption,
  type NeckwearOption,
  type Stats,
  applyAction,
  applyAdventure,
  describeWardrobe,
  deriveHealth,
  resolveActivity,
} from "./creature";
import { type CareEvent, type Creature, type Session, careEvents, creature, sessions } from "./schema";
import { broadcastUpdate } from "./sse";

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
  hat: HatOption | null;
  neckwear: NeckwearOption | null;
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

// The ONE place a lazily-expired sleep gets resolved — used by both the
// read path (toState, below) and the write path (performAction's
// validation step). Unlike a bare call to resolveActivity, this doesn't
// just compute the answer transiently for whoever happened to ask: the
// moment it discovers the cooldown has genuinely passed, it writes that
// back to the stored row immediately, rather than leaving the database
// saying "sleeping" with a long-expired timestamp indefinitely and relying
// on every future caller to independently re-derive the truth. Every
// decision this app makes was already correct before this existed — every
// call site resolved fresh, every time — but the STORED row itself could
// silently disagree with that effective truth for as long as nothing else
// happened to write to it. This closes that gap: stored and effective
// truth never drift apart for longer than one request.
//
// Deliberately called from performAction's validation step too, even for
// an action that goes on to be REJECTED for some unrelated reason (too
// tired, too hungry): that write isn't the action's own effect — it's
// bookkeeping that corrects the row to match time that has already,
// unconditionally passed, identical to what the very next read would do
// regardless of whether this particular action succeeds.
function resolveAndSync(handle: Handle, row: Creature, now: Date): Creature {
  const resolved = resolveActivity(
    { stats: row, activity: row.activity as Activity, activityUntil: row.activityUntil },
    now,
  );
  if (resolved.activity === row.activity) return row; // nothing changed, nothing to persist
  handle
    .update(creature)
    .set({ activity: resolved.activity, activityUntil: resolved.activityUntil })
    .where(eq(creature.id, CREATURE_ID))
    .run();
  return { ...row, activity: resolved.activity, activityUntil: resolved.activityUntil };
}

function toState(handle: Handle, row: Creature): CreatureState {
  const resolvedRow = resolveAndSync(handle, row, new Date());
  const lastActor = resolvedRow.lastActorSessionId
    ? handle
        .select({ label: sessions.label })
        .from(sessions)
        .where(eq(sessions.id, resolvedRow.lastActorSessionId))
        .get()
    : undefined;
  return {
    stats: resolvedRow,
    health: deriveHealth(resolvedRow),
    activity: resolvedRow.activity as Activity,
    activityUntil: resolvedRow.activityUntil,
    lastAction: resolvedRow.lastAction,
    lastActorLabel: lastActor?.label ?? null,
    updatedAt: resolvedRow.updatedAt,
    history: listRecentCareHistory(handle, CARE_HISTORY_DISPLAY),
    // Stored as plain `text` (nullable) in schema.ts; the vocabulary that
    // makes these HatOption/NeckwearOption is only ever written through
    // performWardrobeChange()'s validation below, so a cast here is safe —
    // the column can never hold anything outside that vocabulary in practice.
    hat: resolvedRow.hat as HatOption | null,
    neckwear: resolvedRow.neckwear as NeckwearOption | null,
  };
}

// Read-only, no transaction needed: the earliest a session row was ever
// created. Stable once set (sessions.createdAt is written once at insert
// and never touched again — only lastSeenAt is), and never empty by the
// time anything asks, since getOrCreateSession() has already run for
// whoever's asking before this is ever called (src/pages/index.astro).
// Examined, not assumed: no existing field on `creature` itself is stable
// (updatedAt changes on every mutation), so this reuses `sessions` rather
// than adding a new column for Milo's age.
export function getMiloAge(): string | null {
  const row = db.select({ first: min(sessions.createdAt) }).from(sessions).get();
  return row?.first ?? null;
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
// current row, resolve any expired sleep (via the same resolveAndSync the
// read path uses — see its comment above), validate, compute the new
// state, write it back, record who did it — all without an `await`
// anywhere in between, which is what makes two concurrent requests resolve
// deterministically in arrival order rather than racing each other (see
// PROCESS.md, Decision 4). A rejected action changes none of ITS OWN
// effects: no stats change, no care_events row, no last-actor update — the
// one exception is resolveAndSync's own housekeeping write, which happens
// regardless of this action's outcome because it isn't this action's
// effect at all.
export function performAction(action: ActionName, sessionId: string): CreatureState | ActionRejection {
  const result = db.transaction((tx) => {
    const row = readRow(tx);
    const now = new Date();
    const resolvedRow = resolveAndSync(tx, row, now);
    const resolved = {
      stats: resolvedRow as Stats,
      activity: resolvedRow.activity as Activity,
      activityUntil: resolvedRow.activityUntil,
    };
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

  // Broadcast only after the transaction has actually committed, and only
  // on success — a rejection never reaches here, so it never produces an
  // update event (src/lib/sse.ts). This runs outside the transaction
  // deliberately: it's a side effect, not a database write, and it must
  // never run for a mutation that could still be rolled back.
  if (!("reason" in result)) broadcastUpdate();

  return result;
}

export type WardrobeSlot = "hat" | "neckwear";

// Same transactional shape as performAction (one db.transaction, no await
// inside), but never rejects: a wardrobe change is cosmetic, touches no
// stat, and is allowed even while asleep — there's no rule for it to break.
// Still goes through a transaction and still writes one care_events row,
// because "shared, attributed, visible in Recent care" is the whole point
// (CLAUDE.md, Decision 6), not just a bonus for the five care actions.
//
// Takes ONE slot and its new value — never both slots at once — and reads
// the CURRENT row for whichever slot isn't being touched, inside this same
// transaction. This is the fix for a real lost-update bug found in review:
// the original version took a full {hat, neckwear} pair from the client,
// which included whatever value that client's page happened to show for
// the slot it *wasn't* changing — correct only as long as nothing else had
// changed that slot since that page was rendered. Two sessions changing
// different slots in quick succession (or even one session acting on a
// page it loaded a while ago) could silently revert the other session's
// choice. Reading the untouched slot fresh, inside the same transaction
// that writes the touched one, makes that impossible regardless of how
// stale either client's rendered page is — the same "always derive from a
// fresh read inside the transaction" principle performAction already
// follows for stats (PROCESS.md, Decision 4), just not followed here
// originally.
export function performWardrobeChange(slot: WardrobeSlot, value: string | null, sessionId: string): CreatureState {
  const result = db.transaction((tx) => {
    const row = readRow(tx);
    // `value` is validated against the right vocabulary for `slot` by the
    // caller (api/wardrobe.ts's isHatOption/isNeckwearOption) before this
    // ever runs — the casts here just reflect that already-checked fact,
    // not a new assumption.
    const hat = slot === "hat" ? (value as HatOption | null) : ((row.hat as HatOption | null) ?? null);
    const neckwear = slot === "neckwear" ? (value as NeckwearOption | null) : ((row.neckwear as NeckwearOption | null) ?? null);

    tx.update(creature)
      .set({
        hat,
        neckwear,
        lastAction: "wardrobe",
        lastActorSessionId: sessionId,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, CREATURE_ID))
      .run();

    tx.insert(careEvents)
      .values({ sessionId, action: "wardrobe", summary: describeWardrobe(hat, neckwear) })
      .run();
    pruneCareHistory(tx);

    return toState(tx, readRow(tx));
  });

  broadcastUpdate();
  return result;
}

// Same transactional pattern as performAction: read, resolve any expired
// sleep, validate via the pure applyAdventure (src/lib/creature.ts), write,
// record, prune, return the fresh state — all inside one transaction, no
// `await` in between, for the same concurrency reason as every other
// mutation here (PROCESS.md, Decision 4).
export function performAdventure(sessionId: string): CreatureState | ActionRejection {
  const result = db.transaction((tx) => {
    const row = readRow(tx);
    const now = new Date();
    const resolvedRow = resolveAndSync(tx, row, now);
    const resolved = {
      stats: resolvedRow as Stats,
      activity: resolvedRow.activity as Activity,
      activityUntil: resolvedRow.activityUntil,
    };
    const outcome = applyAdventure(resolved);
    if (!outcome.ok) return { reason: outcome.reason };

    tx.update(creature)
      .set({
        ...outcome.result.stats,
        activity: outcome.result.activity,
        activityUntil: outcome.result.activityUntil,
        lastAction: "adventure",
        lastActorSessionId: sessionId,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, CREATURE_ID))
      .run();

    tx.insert(careEvents).values({ sessionId, action: "adventure", summary: outcome.result.summary }).run();
    pruneCareHistory(tx);

    return toState(tx, readRow(tx));
  });

  if (!("reason" in result)) broadcastUpdate();
  return result;
}

export type { CareEvent, Session };
