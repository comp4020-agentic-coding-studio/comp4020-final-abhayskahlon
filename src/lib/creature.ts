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

// ---- appearance: five authored looks for the one shared creature ----------
// PROCESS.md, Decision 15. A fixed, small vocabulary — exactly like
// hat/neckwear below — not a per-visitor choice and not a naming feature
// (CLAUDE.md): every visitor in the room sees the same appearance, and
// switching it changes only which component renders. "milo" is both the
// first-ever and the default value, so every pre-Decision-15 room (and
// every freshly hosted one) starts there with no migration guesswork.
export const APPEARANCES = ["milo", "plip", "bella", "simbaa", "oliver"] as const;
export type AppearanceId = (typeof APPEARANCES)[number];

export const APPEARANCE_LABELS: Record<AppearanceId, string> = {
  milo: "Milo",
  plip: "Plip",
  bella: "Bella",
  simbaa: "Simbaa",
  oliver: "Oliver",
};

export function isAppearanceId(value: string): value is AppearanceId {
  return (APPEARANCES as readonly string[]).includes(value);
}

// ---- shared wardrobe: cosmetic, free, not an inventory ---------------------
// Three independent slots, each resolving against one fixed, authored
// registry below (never free text) — validated the same way ACTIONS is.
// Deliberately kept out of ACTIONS/applyAction entirely: this isn't a
// sixth care action, and the five-action contract (CLAUDE.md, "Exactly
// five actions") stays exactly five, in code and in what ACTIONS.length
// reports.
export type AccessorySlot = "hat" | "glasses" | "neckwear";

export interface AccessoryDef {
  id: string;
  slot: AccessorySlot;
  label: string;
  // The shared level (getProgression, below) at which this becomes
  // equippable — PROCESS.md, Decision 16. 1 means "available from the
  // start," the same as every item that existed before levels did.
  unlockLevel: 1 | 2 | 3 | 4 | 5;
  // "all", or the specific appearances this item's artwork actually
  // supports. Kept to one deliberate, tested example (bunny-ears excluding
  // oliver, who's already a rabbit) rather than guessing many borderline
  // cases — see PROCESS.md, Decision 16.
  compatible: "all" | readonly AppearanceId[];
}

// The original two hats and two neckwear items are preserved verbatim as
// level-1 entries — nothing that was always available stops being so.
export const ACCESSORIES: readonly AccessoryDef[] = [
  { id: "top-hat", slot: "hat", label: "Top Hat", unlockLevel: 1, compatible: "all" },
  { id: "party-hat", slot: "hat", label: "Party Hat", unlockLevel: 1, compatible: "all" },
  { id: "bow-tie", slot: "neckwear", label: "Bow Tie", unlockLevel: 1, compatible: "all" },
  { id: "scarf", slot: "neckwear", label: "Scarf", unlockLevel: 1, compatible: "all" },
  { id: "beanie", slot: "hat", label: "Beanie", unlockLevel: 2, compatible: "all" },
  { id: "knit-scarf", slot: "neckwear", label: "Knit Scarf", unlockLevel: 2, compatible: "all" },
  { id: "bunny-ears", slot: "hat", label: "Bunny Ears", unlockLevel: 3, compatible: ["milo", "plip", "bella", "simbaa"] },
  { id: "round-glasses", slot: "glasses", label: "Round Glasses", unlockLevel: 3, compatible: "all" },
  { id: "wizard-hat", slot: "hat", label: "Wizard Hat", unlockLevel: 4, compatible: "all" },
  { id: "heart-glasses", slot: "glasses", label: "Heart Glasses", unlockLevel: 4, compatible: "all" },
  { id: "golden-crown", slot: "hat", label: "Golden Crown", unlockLevel: 5, compatible: "all" },
];

const ACCESSORY_BY_ID = new Map(ACCESSORIES.map((item) => [item.id, item]));

export type HatOption = string;
export type NeckwearOption = string;
export type GlassesOption = string;

export function findAccessory(id: string): AccessoryDef | undefined {
  return ACCESSORY_BY_ID.get(id);
}

// `null` means "take it off" for that slot — always a valid choice, never a
// rejection, since it never touches a stat or depends on activity. A
// non-null value is only a VALID *shape* check here (the right slot, a
// known id) — whether it's currently *equippable* depends on the room's
// live level/appearance, so that check happens where the level is read:
// inside performWardrobeChange's transaction (src/lib/db.ts), the same
// place every other stateful rule in this app is enforced.
export function isAccessoryOption(slot: AccessorySlot, value: string | null): boolean {
  if (value === null) return true;
  const item = ACCESSORY_BY_ID.get(value);
  return item !== undefined && item.slot === slot;
}

// Back-compat named checks some call sites still read more naturally —
// thin wrappers over the one real check above, not a second source of truth.
export function isHatOption(value: string | null): boolean {
  return isAccessoryOption("hat", value);
}
export function isNeckwearOption(value: string | null): boolean {
  return isAccessoryOption("neckwear", value);
}
export function isGlassesOption(value: string | null): boolean {
  return isAccessoryOption("glasses", value);
}

function accessoryLabel(id: string): string {
  return ACCESSORY_BY_ID.get(id)?.label ?? id;
}

// A short, human summary of what changed — mirrors applyAction's summary
// strings so the same Recent-care sentence template works unmodified.
export function describeWardrobe(hat: string | null, neckwear: string | null, glasses: string | null = null): string {
  const worn = [hat, glasses, neckwear].filter((item): item is string => item !== null);
  if (worn.length === 0) return "now wearing nothing special";
  return `now wearing: ${worn.map(accessoryLabel).join(", ")}`;
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

// ---- adventure: a shared activity, not a sixth care action -----------------
// Deliberately not part of ACTIONS/applyAction's switch — same reasoning as
// the wardrobe functions above. One adventure, one deterministic outcome:
// no dice roll on success/failure (the brief explicitly rules out "random
// failures"), and the one real rejection rule it does follow is the exact
// same "not while asleep" rule every non-clean/non-sleep action already
// follows (applyAction, above) — not a new rule invented for this. The
// biggest cleanliness cost of anything in the game is the point: it's what
// pushes the real, already-existing messy-family expression (Milo.astro)
// to show up on its own, which is what "visually indicates a Clean would
// help" means here — no separate visual mechanic for this.
export function applyAdventure(snapshot: CreatureSnapshot): ActionOutcome {
  if (snapshot.activity === "sleeping") {
    return { ok: false, reason: "the creature is asleep right now" };
  }
  return unchanged(
    {
      ...snapshot.stats,
      happiness: clamp(snapshot.stats.happiness + 15),
      energy: clamp(snapshot.stats.energy - 10),
      cleanliness: clamp(snapshot.stats.cleanliness - 30),
    },
    snapshot,
    "happiness +15, energy −10, cleanliness −30 — came back muddy",
  );
}

// ---- milestones: a shared, room-level progress track ----------------------
// PROCESS.md, Decision 14. Pure flavor text derived from
// `creature.totalCareActions` (schema.ts) — never a new mechanic, never a
// stat boost, never anything that changes what an action does. The room's
// own lifetime total, nothing else: this never takes a session id, a
// per-visitor count, or anything that could be used to compare one
// visitor's contribution against another's (PROCESS.md, Decision 6).
//
// Five fixed, ascending thresholds — modest and deliberately short, the
// same "a small persistent thing, not a sprawling content system" scope
// every other feature in this app keeps to (Decision 8's "capped, not
// unbounded" framing, applied here to the *number of milestones* rather
// than a row count).
export const CARE_MILESTONES = [10, 50, 100, 250, 500] as const;

export const MILESTONE_LABELS: Record<(typeof CARE_MILESTONES)[number], string> = {
  10: "Settling in",
  50: "Well cared for",
  100: "A real routine",
  250: "Old hands at this",
  500: "Inseparable",
};

export interface MilestoneInfo {
  // The highest threshold reached so far, or null if none yet.
  reached: (typeof CARE_MILESTONES)[number] | null;
  label: string | null; // MILESTONE_LABELS[reached], or null to match
  // The next threshold to work toward, or null once every milestone here
  // has been reached — "maxed out," not an error state.
  next: (typeof CARE_MILESTONES)[number] | null;
  // 0–100, how far toward `next` the room's total currently is. 100 when
  // `next` is null (every milestone already reached).
  progress: number;
}

export function getMilestone(totalCareActions: number): MilestoneInfo {
  let reached: (typeof CARE_MILESTONES)[number] | null = null;
  for (const threshold of CARE_MILESTONES) {
    if (totalCareActions >= threshold) reached = threshold;
  }
  const next = CARE_MILESTONES.find((threshold) => totalCareActions < threshold) ?? null;
  const progress = next === null ? 100 : Math.round((totalCareActions / next) * 100);
  return { reached, label: reached === null ? null : MILESTONE_LABELS[reached], next, progress };
}

// ---- progression: shared XP and levels, a SECOND track alongside milestones
// PROCESS.md, Decision 16. Deliberately independent of CARE_MILESTONES
// above — that system stays exactly as it was, unranked flavor text off a
// lifetime action count; this one is a separate, also-unranked, also
// room-level (never per-visitor) arc that caps at a fixed level and gates
// cosmetics. Both read the same underlying "did a real action succeed"
// event, but neither is derived from the other.
export const LEVEL_CAP = 5;

// Flat per action — uniform on purpose (PROCESS.md, Decision 16): no
// single action is ever "the efficient one to spam," the same spirit as
// every action but clean already costing something (Decision 3).
export const XP_PER_ACTION = 20;

// Cumulative XP at which each level BEGINS — index 0 is level 1's floor (0
// XP). The brief's 100/200/300/400 figures are the XP REQUIRED FOR each
// transition, not cumulative totals, so the cumulative floors below are
// their running sum: 100, 100+200=300, 300+300=600, 600+400=1000.
export const LEVEL_XP_THRESHOLDS = [0, 100, 300, 600, 1000] as const;

export interface Progression {
  level: number; // 1..LEVEL_CAP, always derived — never its own column
  xp: number; // the raw cumulative value this was computed from
  xpIntoLevel: number; // progress within the current level
  xpForNextLevel: number | null; // XP needed total for the NEXT level; null at the cap
  progress: number; // 0-100 within the current level; 100 and only 100 at the cap
}

// Pure and total over all non-negative xp, including values past the top
// threshold (xp keeps counting after level 5 — see schema.ts) — this is
// the one place that clamps the derived level, so nowhere else needs its
// own cap logic. Mirrors deriveHealth()'s "compute fresh, never store"
// shape exactly.
export function getProgression(xp: number): Progression {
  let level = 1;
  for (let i = 1; i < LEVEL_XP_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_XP_THRESHOLDS[i]) level = i + 1;
  }
  const floor = LEVEL_XP_THRESHOLDS[level - 1];
  const nextThreshold = level < LEVEL_CAP ? LEVEL_XP_THRESHOLDS[level] : null;
  const xpIntoLevel = xp - floor;
  const progress = nextThreshold === null ? 100 : Math.round((xpIntoLevel / (nextThreshold - floor)) * 100);
  return { level, xp, xpIntoLevel, xpForNextLevel: nextThreshold, progress };
}
