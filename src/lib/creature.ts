// Pure transition logic: no database, no I/O, so it's trivially unit
// testable and trivially safe to call from inside a transaction with no
// `await` anywhere near it (see PROCESS.md, Decision 4). src/lib/db.ts is
// the only thing that persists what this computes.

export interface Stats {
  hunger: number; // how FED the creature is — higher is better (see schema.ts)
  energy: number;
  happiness: number;
  cleanliness: number;
}

export type Activity = "idle" | "sleeping";

// Only `feed` exists so far — the other four land in the next commit, once
// this shape is proven end to end (schema → transition → persistence →
// render).
export const ACTIONS = ["feed"] as const;
export type ActionName = (typeof ACTIONS)[number];

export interface CreatureSnapshot {
  stats: Stats;
  activity: Activity;
  activityUntil: string | null;
}

export interface AppliedAction {
  stats: Stats;
  activity: Activity;
  activityUntil: string | null;
  summary: string;
}

export type ActionOutcome = { ok: true; result: AppliedAction } | { ok: false; reason: string };

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// A simple average of the four needs. Deliberately never stored and never
// mutated directly — see PROCESS.md, Decision 2. Read-only, every time.
export function deriveHealth(stats: Stats): number {
  return Math.round((stats.hunger + stats.energy + stats.happiness + stats.cleanliness) / 4);
}

// The only "wake" mechanism in this app: a held "sleeping" state resolves
// back to "idle" once its cooldown has passed, checked lazily wherever a
// read or an action touches the creature. No cron, no background timer.
export function resolveActivity(snapshot: CreatureSnapshot, now: Date): CreatureSnapshot {
  if (snapshot.activity === "sleeping" && snapshot.activityUntil && new Date(snapshot.activityUntil) <= now) {
    return { ...snapshot, activity: "idle", activityUntil: null };
  }
  return snapshot;
}

// Applies one named action to a (already activity-resolved) snapshot.
// Never mutates its input; always returns either the new state or a
// rejection reason — never silently clamps an action that shouldn't have
// been allowed into something that looks valid.
export function applyAction(action: ActionName, snapshot: CreatureSnapshot): ActionOutcome {
  switch (action) {
    case "feed": {
      const stats: Stats = {
        ...snapshot.stats,
        hunger: clamp(snapshot.stats.hunger + 30),
        happiness: clamp(snapshot.stats.happiness + 5),
        cleanliness: clamp(snapshot.stats.cleanliness - 5),
      };
      return {
        ok: true,
        result: {
          stats,
          activity: snapshot.activity,
          activityUntil: snapshot.activityUntil,
          summary: "fullness +30, happiness +5, cleanliness −5",
        },
      };
    }
    default: {
      const _exhaustive: never = action;
      return { ok: false, reason: `unknown action: ${_exhaustive}` };
    }
  }
}
