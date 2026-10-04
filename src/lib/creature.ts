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

export const ACTIONS = ["feed", "play", "walk", "clean", "sleep"] as const;
export type ActionName = (typeof ACTIONS)[number];

// How long a sleep cooldown holds the creature unavailable for feed/play/
// walk. Overridable so the spec harness's local-spawn path doesn't sit
// through it for real (see spec/global-setup.ts); never set in fly.toml or
// the Dockerfile — a production boot always uses this real default. Modest
// on purpose: long enough to be a felt, real cost for whoever else is in
// the room right now, short enough that a crit demo can watch it resolve.
const SLEEP_COOLDOWN_MS = Number(process.env.SLEEP_COOLDOWN_MS ?? 8000);

const ENERGY_FOR_PLAY = 15;
const ENERGY_FOR_WALK = 10;
const HUNGER_TO_SLEEP = 20;

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

function unchanged(stats: Stats, snapshot: CreatureSnapshot, summary: string): ActionOutcome {
  return { ok: true, result: { stats, activity: snapshot.activity, activityUntil: snapshot.activityUntil, summary } };
}

// Applies one named action to a (already activity-resolved) snapshot.
// Never mutates its input; always returns either the new state or a
// rejection reason — never silently clamps an action that shouldn't have
// been allowed into something that looks valid. `now` only matters for
// `sleep`, which stamps when its cooldown ends.
//
// Every action but `clean` both gives and costs something (PROCESS.md,
// Decision 3) — that trade-off is the point: one visitor's action changes
// what the next visitor should reasonably do.
export function applyAction(action: ActionName, snapshot: CreatureSnapshot, now: Date): ActionOutcome {
  if (snapshot.activity === "sleeping" && action !== "clean" && action !== "sleep") {
    return { ok: false, reason: "the creature is asleep right now" };
  }

  switch (action) {
    case "feed":
      return unchanged(
        {
          ...snapshot.stats,
          hunger: clamp(snapshot.stats.hunger + 30),
          happiness: clamp(snapshot.stats.happiness + 5),
          cleanliness: clamp(snapshot.stats.cleanliness - 5),
        },
        snapshot,
        "fullness +30, happiness +5, cleanliness −5",
      );

    case "play":
      if (snapshot.stats.energy < ENERGY_FOR_PLAY) {
        return { ok: false, reason: "too tired to play" };
      }
      return unchanged(
        {
          ...snapshot.stats,
          energy: clamp(snapshot.stats.energy - 15),
          happiness: clamp(snapshot.stats.happiness + 20),
          hunger: clamp(snapshot.stats.hunger - 10),
          cleanliness: clamp(snapshot.stats.cleanliness - 10),
        },
        snapshot,
        "happiness +20, energy −15, fullness −10, cleanliness −10",
      );

    case "walk":
      if (snapshot.stats.energy < ENERGY_FOR_WALK) {
        return { ok: false, reason: "too tired to walk" };
      }
      return unchanged(
        {
          ...snapshot.stats,
          energy: clamp(snapshot.stats.energy - 10),
          happiness: clamp(snapshot.stats.happiness + 10),
          hunger: clamp(snapshot.stats.hunger - 5),
          cleanliness: clamp(snapshot.stats.cleanliness - 15),
        },
        snapshot,
        "happiness +10, energy −10, fullness −5, cleanliness −15",
      );

    case "clean":
      return unchanged(
        { ...snapshot.stats, cleanliness: 100, happiness: clamp(snapshot.stats.happiness + 5) },
        snapshot,
        "cleanliness → 100, happiness +5",
      );

    case "sleep":
      if (snapshot.activity === "sleeping") {
        return { ok: false, reason: "already asleep" };
      }
      if (snapshot.stats.hunger < HUNGER_TO_SLEEP) {
        return { ok: false, reason: "too hungry to sleep" };
      }
      return {
        ok: true,
        result: {
          stats: { ...snapshot.stats, energy: 100 },
          activity: "sleeping",
          activityUntil: new Date(now.getTime() + SLEEP_COOLDOWN_MS).toISOString(),
          summary: `energy → 100, asleep for ${Math.round(SLEEP_COOLDOWN_MS / 1000)}s`,
        },
      };

    default: {
      const _exhaustive: never = action;
      return { ok: false, reason: `unknown action: ${_exhaustive}` };
    }
  }
}
