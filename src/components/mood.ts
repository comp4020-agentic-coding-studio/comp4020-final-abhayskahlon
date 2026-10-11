// Milo's real condition, computed once and shared by Milo.astro (the face)
// and Dialogue.astro (the text) — a pure function of the same `stats` and
// `activity` already shown as numbers/text elsewhere on the page. Extracted
// from Milo.astro now that a second genuine consumer needs it; kept out of
// src/lib/ deliberately, since src/lib/* is the validated, authoritative
// business-logic layer (CLAUDE.md) and nothing here is ever used to accept
// or reject an action — it's a read of public state, not a rule.
import type { Activity, Stats } from "../lib/creature";

// Presentational-only bands, independent of src/lib/creature.ts's real
// action-validation thresholds (ENERGY_FOR_PLAY, ENERGY_FOR_WALK,
// HUNGER_TO_SLEEP) — deliberately not imported, so a tweak to either one
// never silently changes the other, and this view is never mistaken for
// the mechanic itself.
export const MOOD_CONCERN = 35;
export const MOOD_SEVERE = 15;
export const MOOD_EXCITED = 85;

export type MoodFamily = "sleeping" | "happy" | "excited" | "sleepy" | "hungry" | "sad" | "messy";

export interface Mood {
  family: MoodFamily;
  severe: boolean;
}

export function computeMood(stats: Stats, activity: Activity): Mood {
  if (activity === "sleeping") return { family: "sleeping", severe: false };

  // Whichever real stat is lowest drives the expression — not a fixed
  // weighting, so "more pronounced as it falls" holds for every family.
  // The listed order only breaks an exact tie.
  const candidates: { key: keyof Stats; family: MoodFamily }[] = [
    { key: "energy", family: "sleepy" },
    { key: "hunger", family: "hungry" },
    { key: "happiness", family: "sad" },
    { key: "cleanliness", family: "messy" },
  ];
  let worst = candidates[0];
  for (const c of candidates) {
    if (stats[c.key] < stats[worst.key]) worst = c;
  }
  if (stats[worst.key] < MOOD_CONCERN) {
    return { family: worst.family, severe: stats[worst.key] < MOOD_SEVERE };
  }
  if (stats.happiness >= MOOD_EXCITED) return { family: "excited", severe: false };
  return { family: "happy", severe: false };
}
