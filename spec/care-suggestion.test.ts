import { describe, expect, it } from "vitest";
import { ENERGY_FOR_PLAY, HUNGER_TO_SLEEP, type Stats } from "../src/lib/creature";
import { suggestNextCare } from "../src/components/suggestions";

// Pure unit coverage of suggestNextCare() (no server needed) — PROCESS.md,
// Decision 17. The one invariant worth protecting here is that a
// suggestion never recommends an action the server would immediately
// reject (src/lib/creature.ts's applyAction) — everything else is just
// wording, which no test should pin down.
function stats(overrides: Partial<Stats> = {}): Stats {
  return { hunger: 80, energy: 80, happiness: 80, cleanliness: 80, ...overrides };
}

describe("suggestNextCare: pure suggestion logic", () => {
  it("suggests nothing while every stat is comfortably high", () => {
    expect(suggestNextCare(stats(), "idle")).toEqual([]);
  });

  it("suggests nothing at all while asleep, regardless of how low stats are", () => {
    expect(suggestNextCare(stats({ hunger: 0, energy: 0, happiness: 0, cleanliness: 0 }), "sleeping")).toEqual([]);
  });

  it("suggests feed when fullness is low", () => {
    const result = suggestNextCare(stats({ hunger: 10 }), "idle");
    expect(result[0]?.action).toBe("feed");
  });

  it("never suggests play when energy is below the real play threshold", () => {
    const result = suggestNextCare(stats({ happiness: 10, energy: ENERGY_FOR_PLAY - 1 }), "idle");
    expect(result.some((s) => s.action === "play")).toBe(false);
  });

  it("suggests play when happiness is low and energy is actually enough to play", () => {
    const result = suggestNextCare(stats({ happiness: 10, energy: ENERGY_FOR_PLAY }), "idle");
    expect(result.some((s) => s.action === "play")).toBe(true);
  });

  it("never suggests sleep when hunger is below the real sleep threshold", () => {
    const result = suggestNextCare(stats({ energy: 5, hunger: HUNGER_TO_SLEEP - 1 }), "idle");
    expect(result.some((s) => s.action === "sleep")).toBe(false);
  });

  it("suggests sleep when energy is low and hunger is actually enough to sleep", () => {
    const result = suggestNextCare(stats({ energy: 5, hunger: HUNGER_TO_SLEEP }), "idle");
    expect(result.some((s) => s.action === "sleep")).toBe(true);
  });

  it("puts the worst stat's suggestion first when multiple stats are low", () => {
    const result = suggestNextCare(stats({ hunger: 20, cleanliness: 5 }), "idle");
    expect(result[0]?.action).toBe("clean");
  });

  it("never returns more than two suggestions", () => {
    const result = suggestNextCare(stats({ hunger: 10, happiness: 10, cleanliness: 10, energy: 90 }), "idle");
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
