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
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type Creature = typeof creature.$inferSelect;
