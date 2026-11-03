// A small, read-only "what might help next" hint — PROCESS.md, Decision
// 17. Kept here, not in src/lib/, for the same reason mood.ts and
// dialogue.ts already are: this never accepts or rejects an action, it
// only reads public state and suggests what a visitor could try, so it
// isn't part of the validated business-logic layer CLAUDE.md reserves for
// src/lib/*.
//
// Deliberately reuses applyAction's REAL rejection thresholds
// (ENERGY_FOR_PLAY, ENERGY_FOR_WALK, HUNGER_TO_SLEEP, src/lib/creature.ts)
// rather than inventing a second copy of those numbers — a suggestion that
// recommended an action the server would immediately reject would be
// actively misleading, not just unhelpful.
import { ENERGY_FOR_PLAY, HUNGER_TO_SLEEP, type ActionName, type Activity, type Stats } from "../lib/creature";
import { MOOD_CONCERN } from "./mood";

export interface CareSuggestion {
  action: ActionName;
  reason: string;
}

// One candidate per stat, ordered to match computeMood's own tie-break
// order (mood.ts) — not load-bearing here since every candidate is
// independently gated by its own rule below, but keeping the same order
// means a tie reads the same stat as "worst" in both places.
const CANDIDATES: { key: keyof Stats; action: ActionName; reason: string; eligible: (stats: Stats) => boolean }[] = [
  {
    key: "hunger",
    action: "feed",
    // Describes the STAT, never the action — the template this feeds
    // (src/pages/index.astro) already says "A Feed might help", so the
    // reason restating "a feed..." would just repeat itself back.
    reason: "fullness is getting low",
    eligible: () => true, // feed has no rejection condition to respect
  },
  {
    key: "happiness",
    action: "play",
    reason: "happiness could use a boost",
    eligible: (stats) => stats.energy >= ENERGY_FOR_PLAY,
  },
  {
    key: "cleanliness",
    action: "clean",
    reason: "cleanliness is dropping",
    eligible: () => true, // clean has no rejection condition to respect
  },
  {
    key: "energy",
    action: "sleep",
    reason: "energy is running low",
    eligible: (stats) => stats.hunger >= HUNGER_TO_SLEEP,
  },
];

// Up to two friendly, non-judgemental suggestions, worst stat first.
// Never suggests an action the server would reject right now (asleep, or
// an action's own threshold not met) — an unhelpful suggestion is fine;
// a wrong one isn't. Nothing here is stored, broadcast, or read by any
// action-validation code — it's presentation only, recomputed on every
// render straight from the same stats already shown as numbers.
export function suggestNextCare(stats: Stats, activity: Activity): CareSuggestion[] {
  if (activity === "sleeping") return [];

  const ranked = CANDIDATES.filter((c) => stats[c.key] < MOOD_CONCERN && c.eligible(stats)).sort((a, b) => stats[a.key] - stats[b.key]);

  return ranked.slice(0, 2).map(({ action, reason }) => ({ action, reason }));
}
