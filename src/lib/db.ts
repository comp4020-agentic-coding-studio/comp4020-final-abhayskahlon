import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
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
import { logCareEvent, logRoomEvent } from "./log";
import { generateRoomCode } from "./room";
import { type CareEvent, type Creature, type Room, type Session, careEvents, creature, rooms, sessions } from "./schema";
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

// A small, deliberate bound (PROCESS.md, Decision 8) — not unlimited, and
// not an accident discovered later. Applies PER ROOM (Decision 13): each
// room's own history is capped at this many rows, independent of every
// other room's.
const CARE_HISTORY_LIMIT = 50;
// How many of that history the UI actually renders at once; the database
// still keeps CARE_HISTORY_LIMIT regardless of this.
const CARE_HISTORY_DISPLAY = 8;

function readRow(handle: Handle, roomId: string): Creature {
  const row = handle.select().from(creature).where(eq(creature.roomId, roomId)).get();
  if (!row) throw new Error(`creature row missing for room ${roomId} — hostRoom() always creates one`);
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

// ---- rooms: a dedicated shared space, each with its own creature ---------
// See PROCESS.md, Decision 13 and docs/adr/0002-multi-room-identity-and-
// access-control.md — the design this whole module now revolves around.
// The room a mutating request acts on is ALWAYS this: session.roomId, read
// from the trusted, httpOnly session cookie — never a client-supplied
// field. hostRoom()/joinRoom() below are the only two places that value is
// ever set.

export interface SessionRoom {
  id: string;
  hostLabel: string | null;
  createdAt: string;
}

// Reads straight off the Session the caller already has (getOrCreateSession
// already fetched it) — no extra query for the common "does this visitor
// have a room at all" check. Only queries further when they do.
export function getSessionRoom(session: Session): SessionRoom | null {
  if (!session.roomId) return null;
  const row = db
    .select({
      id: rooms.id,
      createdAt: rooms.createdAt,
      hostLabel: sessions.label,
    })
    .from(rooms)
    .leftJoin(sessions, eq(rooms.hostSessionId, sessions.id))
    .where(eq(rooms.id, session.roomId))
    .get();
  // A session whose room_id points at a room that no longer resolves (it
  // can't today — rooms are never deleted — but never trusted blindly
  // either) is treated the same as having no room: fall through to the
  // entry experience rather than crash on a stale reference.
  if (!row) return null;
  return { id: row.id, createdAt: row.createdAt, hostLabel: row.hostLabel ?? null };
}

function findRoom(handle: Handle, id: string): Room | undefined {
  return handle.select().from(rooms).where(eq(rooms.id, id)).get();
}

// Tries a fresh random code, inside the given transaction, until it finds
// one not already taken. The alphabet (31 chars, 6 long — src/lib/room.ts)
// makes a collision astronomically unlikely, but "unlikely" is not "never"
// — this is what makes the guarantee actual rather than assumed. A bound of
// 20 attempts is generous; exhausting it would mean something is
// structurally wrong (e.g. the alphabet shrank drastically), not ordinary
// bad luck, so it throws rather than silently looping forever.
function generateUniqueRoomCode(tx: Handle): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateRoomCode();
    if (!findRoom(tx, code)) return code;
  }
  throw new Error("could not generate a unique room code after 20 attempts");
}

// A fresh creature starts comfortably in the middle of every need, not at
// the extremes — there's something for a room's first visitor to improve,
// but nothing urgent. Matches the defaults the old singleton seed used.
function defaultCreatureStats() {
  return { hunger: 70, energy: 70, happiness: 70, cleanliness: 70, activity: "idle" as const, activityUntil: null };
}

// Creates a brand-new room and its creature together, in one transaction,
// and makes `session` that room's host (attribution only — PROCESS.md,
// Decision 13: no powers an ordinary member lacks). Matches joinRoom()'s
// "joining/hosting always overwrites" rule: a session that already belonged
// to another room simply moves to this new one.
export function hostRoom(session: Session, label: string): Room {
  const room = db.transaction((tx) => {
    const id = generateUniqueRoomCode(tx);
    const newRoom = tx.insert(rooms).values({ id, hostSessionId: session.id }).returning().get();
    tx.insert(creature).values({ roomId: id, ...defaultCreatureStats() }).run();
    tx.update(sessions).set({ label, roomId: id }).where(eq(sessions.id, session.id)).run();
    return newRoom;
  });
  logRoomEvent({ roomId: room.id, sessionId: session.id, sessionLabel: label, type: "room_hosted" });
  return room;
}

export type RoomJoinRejection = { reason: string };

// Validates the room actually exists (the one real, server-side check this
// path makes — see docs/adr/0002) before moving `session` into it. `roomId`
// is assumed already format-validated and normalized by the caller (src/
// pages/api/rooms/join.ts), the same division of labour api/actions.ts uses
// for action names: route validates shape, this validates against the
// database.
export function joinRoom(session: Session, label: string, roomId: string): Room | RoomJoinRejection {
  const room = db.transaction((tx) => {
    const existing = findRoom(tx, roomId);
    if (!existing) return { reason: "no room with that code" };
    tx.update(sessions).set({ label, roomId }).where(eq(sessions.id, session.id)).run();
    return existing;
  });
  if ("reason" in room) {
    logRoomEvent({ roomId: null, sessionId: session.id, sessionLabel: label, type: "room_join_rejected", attemptedCode: roomId, reason: room.reason });
    return room;
  }
  logRoomEvent({ roomId: room.id, sessionId: session.id, sessionLabel: label, type: "room_joined" });
  return room;
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

function listRecentCareHistory(handle: Handle, roomId: string, limit: number): CareHistoryEntry[] {
  return handle
    .select({
      action: careEvents.action,
      summary: careEvents.summary,
      actorLabel: sessions.label,
      createdAt: careEvents.createdAt,
    })
    .from(careEvents)
    .innerJoin(sessions, eq(careEvents.sessionId, sessions.id))
    .where(eq(careEvents.roomId, roomId))
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
    .where(eq(creature.id, row.id))
    .run();
  return { ...row, activity: resolved.activity, activityUntil: resolved.activityUntil };
}

function toState(handle: Handle, row: Creature, roomId: string): CreatureState {
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
    history: listRecentCareHistory(handle, roomId, CARE_HISTORY_DISPLAY),
    // Stored as plain `text` (nullable) in schema.ts; the vocabulary that
    // makes these HatOption/NeckwearOption is only ever written through
    // performWardrobeChange()'s validation below, so a cast here is safe —
    // the column can never hold anything outside that vocabulary in practice.
    hat: resolvedRow.hat as HatOption | null,
    neckwear: resolvedRow.neckwear as NeckwearOption | null,
  };
}

// Always a fresh read from SQLite — never from anything held in a variable
// across requests (see CLAUDE.md).
export function getCreatureState(roomId: string): CreatureState {
  return toState(db, readRow(db, roomId), roomId);
}

// Deletes every care_events row for THIS ROOM beyond the most recent
// CARE_HISTORY_LIMIT — each room's history is capped independently, never
// against the table's total row count. Called after every successful
// action, inside the same transaction, so no room's history ever grows
// past the bound PROCESS.md Decision 8 commits to.
function pruneCareHistory(handle: Handle, roomId: string): void {
  const keep = handle
    .select({ id: careEvents.id })
    .from(careEvents)
    .where(eq(careEvents.roomId, roomId))
    .orderBy(desc(careEvents.id))
    .limit(CARE_HISTORY_LIMIT)
    .all();
  if (keep.length < CARE_HISTORY_LIMIT) return; // nothing to prune yet
  handle
    .delete(careEvents)
    .where(
      and(
        eq(careEvents.roomId, roomId),
        notInArray(
          careEvents.id,
          keep.map((row) => row.id),
        ),
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
//
// `roomId` is the session's OWN room (src/pages/api/actions.ts derives it
// from the trusted session cookie, never from anything the client sends) —
// readRow() below can only ever read or write that one room's creature, so
// there is no code path here through which this action could touch any
// other room's state.
export function performAction(action: ActionName, session: Session, roomId: string): CreatureState | ActionRejection {
  const result = db.transaction((tx) => {
    const row = readRow(tx, roomId);
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
        lastActorSessionId: session.id,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, row.id))
      .run();

    tx.insert(careEvents).values({ sessionId: session.id, roomId, action, summary: outcome.result.summary }).run();
    pruneCareHistory(tx, roomId);

    return toState(tx, readRow(tx, roomId), roomId);
  });

  const outcome = "reason" in result ? "rejected" : "success";
  logCareEvent({
    roomId,
    sessionId: session.id,
    sessionLabel: session.label,
    action,
    outcome,
    ...("reason" in result ? { reason: result.reason } : {}),
  });

  // Broadcast only after the transaction has actually committed, and only
  // on success — a rejection never reaches here, so it never produces an
  // update event (src/lib/sse.ts). This runs outside the transaction
  // deliberately: it's a side effect, not a database write, and it must
  // never run for a mutation that could still be rolled back. Scoped to
  // THIS room only — every other room's open connections are untouched.
  if (!("reason" in result)) broadcastUpdate(roomId);

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
export function performWardrobeChange(slot: WardrobeSlot, value: string | null, session: Session, roomId: string): CreatureState {
  const result = db.transaction((tx) => {
    const row = readRow(tx, roomId);
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
        lastActorSessionId: session.id,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, row.id))
      .run();

    tx.insert(careEvents)
      .values({ sessionId: session.id, roomId, action: "wardrobe", summary: describeWardrobe(hat, neckwear) })
      .run();
    pruneCareHistory(tx, roomId);

    return toState(tx, readRow(tx, roomId), roomId);
  });

  logCareEvent({ roomId, sessionId: session.id, sessionLabel: session.label, action: "wardrobe", outcome: "success" });
  broadcastUpdate(roomId);
  return result;
}

// Same transactional pattern as performAction: read, resolve any expired
// sleep, validate via the pure applyAdventure (src/lib/creature.ts), write,
// record, prune, return the fresh state — all inside one transaction, no
// `await` in between, for the same concurrency reason as every other
// mutation here (PROCESS.md, Decision 4).
export function performAdventure(session: Session, roomId: string): CreatureState | ActionRejection {
  const result = db.transaction((tx) => {
    const row = readRow(tx, roomId);
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
        lastActorSessionId: session.id,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creature.id, row.id))
      .run();

    tx.insert(careEvents).values({ sessionId: session.id, roomId, action: "adventure", summary: outcome.result.summary }).run();
    pruneCareHistory(tx, roomId);

    return toState(tx, readRow(tx, roomId), roomId);
  });

  const outcome = "reason" in result ? "rejected" : "success";
  logCareEvent({
    roomId,
    sessionId: session.id,
    sessionLabel: session.label,
    action: "adventure",
    outcome,
    ...("reason" in result ? { reason: result.reason } : {}),
  });

  if (!("reason" in result)) broadcastUpdate(roomId);
  return result;
}

export type { CareEvent, Room, Session };
