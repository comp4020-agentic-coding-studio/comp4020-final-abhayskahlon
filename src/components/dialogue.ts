// A small, authored set of lines — no external AI, no generation at
// request time beyond picking one of these. Every pool is gated strictly by
// the real computed mood (src/components/mood.ts), itself a pure function
// of the actual stats, so a line can never claim a need that contradicts
// what the stat bars already show.
import type { Activity, Stats } from "../lib/creature";
import { computeMood } from "./mood";

const LINES: Record<string, readonly string[]> = {
  sleeping: ["Shh... fast asleep.", "Dreaming, probably about snacks.", "Resting up for the next visitor."],
  happy: [
    "Doing well today, thanks for checking in.",
    "Everything's holding together nicely.",
    "Good to see a friendly face.",
    "All four needs are comfortably met.",
  ],
  excited: ["Best day ever!", "Can barely sit still right now!", "So much energy today!"],
  "sleepy:mild": ["Getting a little drowsy...", "Could use a nap before too long.", "Eyes feel a bit heavy."],
  "sleepy:severe": ["Can barely keep my eyes open...", "*yawn* ...really tired now.", "Could really use some Sleep."],
  "hungry:mild": ["Starting to feel a little peckish.", "A snack would be nice about now.", "Stomach's rumbling, just a bit."],
  "hungry:severe": ["Really hungry now...", "Could use a Feed, honestly.", "Stomach is loudly protesting."],
  "sad:mild": ["Feeling a little down today.", "Could use some company.", "A bit low, if I'm honest."],
  "sad:severe": ["Feeling pretty sad...", "Some Play time would help a lot.", "Everything feels a bit gray right now."],
  "messy:mild": ["Starting to feel a bit grubby.", "Could use a wash soon.", "A little dusty today."],
  "messy:severe": ["Definitely needs a Clean right now.", "Feeling pretty grimy.", "Tracking mud everywhere, oops."],
};

// Deterministic, not random-per-render: the same seed always picks the
// same line. Keeps a plain reload or an unrelated SSE refresh from
// flickering to a different line for no real reason, while still changing
// the moment something real happens (a new top history entry).
function stableHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function moodKey(family: string, severe: boolean): string {
  return family === "sleeping" || family === "happy" || family === "excited" ? family : `${family}:${severe ? "severe" : "mild"}`;
}

// `recentEventSeed` is whatever uniquely identifies "the most recent thing
// that happened" — this page already fetches state.history, so its first
// entry's timestamp is reused rather than adding any new field. `null`
// (nothing has ever happened yet) still picks a stable line, just from a
// fixed seed instead of a real event.
export function pickDialogue(stats: Stats, activity: Activity, recentEventSeed: string | null): string {
  const { family, severe } = computeMood(stats, activity);
  const key = moodKey(family, severe);
  const pool = LINES[key] ?? LINES.happy;
  const index = stableHash(`${key}:${recentEventSeed ?? "new"}`) % pool.length;
  return pool[index];
}
