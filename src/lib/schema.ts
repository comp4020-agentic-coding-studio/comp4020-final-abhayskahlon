import { sql } from "drizzle-orm";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The schema is ground truth. To change it: edit here, run
// `pnpm db:generate` to turn the diff into a migration under drizzle/, and
// commit both — the migration applies automatically when the server boots
// (see src/lib/db.ts). Never edit the database by hand: state on the
// deployed volume outlives every deploy, and the migration trail is what
// keeps old state and new code compatible.

// One shared creature — row id is always 1 (see src/lib/db.ts). No per-user
// creature: COMMONS is one persistent being several people are responsible
// for together, not one pet each.
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
  id: int().primaryKey(),
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
});

// A lightweight, unauthenticated visitor identity: a random token set as an
// httpOnly cookie on first visit (src/lib/session.ts). Good enough to tell
// "who did that" apart in the care history — never a login, never persisted
// across browsers. See PROCESS.md, Decision 7.
export const sessions = sqliteTable("sessions", {
  id: text().primaryKey(),
  label: text().notNull(),
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
  action: text().notNull(),
  summary: text().notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type Creature = typeof creature.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type CareEvent = typeof careEvents.$inferSelect;
