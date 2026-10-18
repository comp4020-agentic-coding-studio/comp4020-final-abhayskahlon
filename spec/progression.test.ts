import { describe, expect, it } from "vitest";
import { LEVEL_CAP, LEVEL_XP_THRESHOLDS, getProgression } from "../src/lib/creature";

// Pure unit coverage of getProgression() itself (no server needed) — the
// XP-AWARDING regression (exactly 20 XP per successful action, 0 for a
// rejection, no lost updates under real concurrency) lives alongside the
// existing care-action tests in spec/concurrency.test.ts, following the
// same split spec/milestones.test.ts already uses between its pure
// getMilestone() unit tests and its server-level award/concurrency tests.
//
// PROCESS.md, Decision 16: the brief's 100/200/300/400 figures are XP
// REQUIRED PER TRANSITION, not cumulative totals — LEVEL_XP_THRESHOLDS'
// cumulative floors are their running sum (0, 100, 300, 600, 1000).
describe("getProgression: pure level/XP logic", () => {
  it("starts at level 1 with 0 xp into the level and 100 needed for level 2", () => {
    const p = getProgression(0);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.xpIntoLevel).toBe(0);
    expect(p.xpForNextLevel).toBe(100);
    expect(p.progress).toBe(0);
  });

  it("stays at level 1 right up to, but not including, the level-2 floor", () => {
    expect(getProgression(99).level).toBe(1);
    expect(getProgression(99).progress).toBe(99);
  });

  it("reaches exactly the next level AT its cumulative threshold, never one xp early or late", () => {
    expect(getProgression(99).level).toBe(1);
    expect(getProgression(100).level).toBe(2);
    expect(getProgression(299).level).toBe(2);
    expect(getProgression(300).level).toBe(3);
    expect(getProgression(599).level).toBe(3);
    expect(getProgression(600).level).toBe(4);
    expect(getProgression(999).level).toBe(4);
    expect(getProgression(1000).level).toBe(5);
  });

  it("reports xpIntoLevel and xpForNextLevel relative to the CURRENT level's own floor, not from zero", () => {
    // Level 3 spans cumulative 300..599 (300 xp wide — the "200 required
    // for level 2→3" transition from the brief).
    const p = getProgression(450);
    expect(p.level).toBe(3);
    expect(p.xpIntoLevel).toBe(150);
    expect(p.xpForNextLevel).toBe(600);
    expect(p.progress).toBe(50);
  });

  it("every one of the four transition widths matches the brief's 100/200/300/400 xp requirements", () => {
    const widths = LEVEL_XP_THRESHOLDS.slice(1).map((floor, i) => floor - LEVEL_XP_THRESHOLDS[i]);
    expect(widths).toEqual([100, 200, 300, 400]);
  });

  it("never exceeds the level cap, however far past the top threshold xp climbs", () => {
    const top = LEVEL_XP_THRESHOLDS[LEVEL_XP_THRESHOLDS.length - 1];
    expect(getProgression(top).level).toBe(LEVEL_CAP);
    expect(getProgression(top + 1).level).toBe(LEVEL_CAP);
    expect(getProgression(top + 1_000_000).level).toBe(LEVEL_CAP);
  });

  it("shows a clear max-level state at the cap: no next level, progress pinned at 100", () => {
    const top = LEVEL_XP_THRESHOLDS[LEVEL_XP_THRESHOLDS.length - 1];
    const p = getProgression(top + 500);
    expect(p.level).toBe(LEVEL_CAP);
    expect(p.xpForNextLevel).toBeNull();
    expect(p.progress).toBe(100);
  });

  it("a single large xp jump crossing multiple thresholds at once still lands correctly, never skipping past the cap", () => {
    // Simulates one action's xp landing a creature from level 1 straight
    // past level 5, which must clamp exactly like any other value above
    // the top threshold — proving the formula itself, not just normal
    // one-action-at-a-time play.
    const p = getProgression(5000);
    expect(p.level).toBe(LEVEL_CAP);
    expect(p.progress).toBe(100);
  });
});
