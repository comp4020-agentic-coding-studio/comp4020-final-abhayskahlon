import { sql } from "drizzle-orm";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The schema is ground truth. To change it: edit here, run
// `pnpm db:generate` to turn the diff into a migration under drizzle/, and
// commit both — the migration applies automatically when the server boots
// (see src/lib/db.ts). Never edit the database by hand: state on the
// deployed volume outlives every deploy, and the migration trail is what
// keeps old state and new code compatible.

// A dedicated room: a group of visitors who chose (by hosting or joining
// with a code) to share one creature together, isolated from every other
// room. `id` is the room code itself — already unique by construction
// (src/lib/room.ts generates it, retried on collision), so there's no
// separate surrogate key. `hostSessionId` is attribution only (PROCESS.md,
// Decision 13): a host has no powers an ordinary member lacks, it's just
// shown ("hosted by X") the same way `creature.lastActorSessionId` is shown
// elsewhere — nullable because the one room backfilled from this app's
// pre-rooms history (`id = "COMMONS"`) never had a recorded host.
export const rooms = sqliteTable("rooms", {
  id: text().primaryKey(),
  hostSessionId: text("host_session_id").references(() => sessions.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// One shared creature PER ROOM (see PROCESS.md, Decision 13, which
// superseded the original "exactly one creature, ever" framing of Decision
// 1). `roomId` is unique: a room has exactly one creature, created the
// moment the room is hosted (src/lib/db.ts hostRoom()) and never
// recreated. Within a room, this is still the same one-shared-being
// COMMONS always was — no per-user creature, no per-user ownership — the
// thing that changed is that "the room" is now an explicit, chosen scope
// instead of the whole deployment.
//
// Convention, easy to get backwards so stated once, here: all four stats
// run in the SAME direction — higher is always better (100 = fully
// satisfied). `hunger` therefore means how FED the creature is, not how
// hungry; the UI labels it "Fullness" for exactly this reason. See
// PROCESS.md, Decision 2.
//
// `health`/condition is deliberately not a column here — it's derived from
// these four on every read (src/lib/creature.ts `deriveHealth`), never
// stored, never its own mechanic.
export const creature = sqliteTable("creature", {
  id: int().primaryKey({ autoIncrement: true }),
  // Nullable at the DB level — same pattern as lastActorSessionId/
  // activityUntil/hat/neckwear below — but always set by application code:
  // hostRoom() (src/lib/db.ts) is the only place a creature row is ever
  // created, and it always sets this in the same transaction. `unique`
  // enforces "a room has exactly one creature" (SQLite's UNIQUE constraint
  // permits any number of NULLs, which only matters for rows that predate
  // this column — see the migration's backfill).
  roomId: text("room_id")
    .unique()
    .references(() => rooms.id),
  hunger: int().notNull(),
  energy: int().notNull(),
  happiness: int().notNull(),
  cleanliness: int().notNull(),
  // "idle" | "sleeping" — see creature.ts for how sleep's cooldown resolves.
  activity: text().notNull(),
  // ISO timestamp the current sleep ends; null while idle.
  activityUntil: text("activity_until"),
  lastAction: text("last_action"),
  // Who did that last action — see `sessions` below. Null only before the
  // first action anyone's ever taken.
  lastActorSessionId: text("last_actor_session_id").references(() => sessions.id),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  // Shared, cosmetic, free — not an inventory: nothing to acquire, no
  // scarcity, no per-user ownership. Each is just "what is Milo wearing
  // right now," the same shape as `activity` being idle/sleeping. Null
  // means that slot is empty; see src/lib/creature.ts for the fixed,
  // authored vocabulary each one is validated against.
  hat: text(),
  neckwear: text(),
});

// A lightweight, unauthenticated visitor identity: a random token set as an
// httpOnly cookie on first visit (src/lib/session.ts). Good enough to tell
// "who did that" apart in the care history — never a login, never persisted
// across browsers. See PROCESS.md, Decision 7.
export const sessions = sqliteTable("sessions", {
  id: text().primaryKey(),
  label: text().notNull(),
  // Nullable: a session exists (and can look at the entry page) before it's
  // joined or hosted any room. Set by hostRoom()/joinRoom() (src/lib/db.ts)
  // — the one thing a session ever does to acquire or change this. See
  // PROCESS.md, Decision 13: joining or hosting always overwrites, so a
  // session belongs to whichever room it most recently chose, not its
  // first one.
  roomId: text("room_id").references(() => rooms.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  lastSeenAt: text("last_seen_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// Append-only care history: every action actually applied, who did it, and
// what changed. Pruned to the most recent rows (src/lib/db.ts) — "a small
// persistent care history" is a deliberate bound, stated once here, not an
// accidental drop of old data discovered later. See PROCESS.md, Decision 8.
export const careEvents = sqliteTable("care_events", {
  id: int().primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  // Captured at action time, independent of the session's CURRENT room
  // (sessions.roomId can change later — see above). This is what keeps a
  // session's history correctly attributed to the room it was actually in
  // when it acted, even after it switches rooms. Nullable at the DB level
  // only for rows that predate this column (see the migration's backfill);
  // every row performAction()/performWardrobeChange()/performAdventure()
  // ever write sets it.
  roomId: text("room_id").references(() => rooms.id),
  action: text().notNull(),
  summary: text().notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type Room = typeof rooms.$inferSelect;
export type Creature = typeof creature.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type CareEvent = typeof careEvents.$inferSelect;
