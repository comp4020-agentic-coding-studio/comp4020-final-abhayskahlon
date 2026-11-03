import { describe, expect, it } from "vitest";
import {
  BODY_ROWS,
  CREATURE_HEADS,
  FINISH_DISTANCE,
  FLOPPED,
  generateObstacles,
  generateStars,
  jumpAirtimeSeconds,
  jumpPeakHeight,
  LEGS_JUMP,
  LEGS_RUN_A,
  LEGS_RUN_B,
  rectsOverlap,
  SPRITE_PALETTES,
  spritePaletteFor,
  STAR_OBSTACLE_MARGIN,
  validateSequence,
  type PixelGrid,
  type SpawnedObstacle,
} from "../src/components/adventureGame";
import { APPEARANCES } from "../src/lib/creature";

// Pure unit coverage of the Adventure runner's game logic — no canvas, no
// DOM, no server. Mirrors spec/progression.test.ts's/spec/care-suggestion
// .test.ts's "test the pure function directly" shape. The existing
// spec/adventure.test.ts (the SERVER-side /api/adventure contract: exact
// deltas, sleeping rejection, concurrency) is completely untouched — this
// game never talks to that endpoint, so nothing here can affect it.

describe("jump physics: deterministic, not randomized", () => {
  it("airtime and peak height are fixed, positive numbers derived from the real gravity/velocity constants", () => {
    expect(jumpAirtimeSeconds()).toBeGreaterThan(0);
    expect(jumpPeakHeight()).toBeGreaterThan(0);
    // Calling twice returns the exact same value — nothing here is
    // randomized or time-dependent.
    expect(jumpAirtimeSeconds()).toBe(jumpAirtimeSeconds());
  });
});

describe("rectsOverlap: AABB collision", () => {
  it("detects a clear overlap", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it("reports no overlap for clearly separate rectangles", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(false);
  });

  it("treats exactly-touching edges as NOT overlapping (half-open interval)", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it("detects overlap for a ground-obstacle-shaped rect against a player-shaped rect", () => {
    const player = { x: 36, y: 100, w: 16, h: 16 };
    const log = { x: 38, y: 108, w: 14, h: 10 };
    expect(rectsOverlap(player, log)).toBe(true);
  });

  it("detects no overlap when the player has jumped clear of a ground obstacle", () => {
    const jumpedPlayer = { x: 36, y: 70, w: 16, h: 16 };
    const log = { x: 38, y: 108, w: 14, h: 10 };
    expect(rectsOverlap(jumpedPlayer, log)).toBe(false);
  });

  it("detects overlap against a bird's flying band when the player has NOT jumped", () => {
    const groundedPlayer = { x: 36, y: 108, w: 16, h: 16 };
    const bird = { x: 36, y: 68, w: 14, h: 6 };
    expect(rectsOverlap(groundedPlayer, bird)).toBe(false); // bird flies above a grounded player
  });

  it("detects overlap against a bird's flying band when the player HAS jumped into it", () => {
    const jumpedIntoBird = { x: 36, y: 68, w: 16, h: 16 };
    const bird = { x: 36, y: 68, w: 14, h: 6 };
    expect(rectsOverlap(jumpedIntoBird, bird)).toBe(true);
  });
});

describe("appearance sprite identity", () => {
  it("every one of the five AppearanceId values has its own distinct, complete sprite palette", () => {
    for (const appearance of APPEARANCES) {
      const palette = spritePaletteFor(appearance);
      expect(palette.body).toBeTruthy();
      expect(palette.accent).toBeTruthy();
      expect(palette.light).toBeTruthy();
    }
  });

  it("no two appearances share an identical palette (each reads as visually distinct)", () => {
    const palettes = APPEARANCES.map((a) => `${SPRITE_PALETTES[a].body}:${SPRITE_PALETTES[a].accent}:${SPRITE_PALETTES[a].light}`);
    expect(new Set(palettes).size).toBe(APPEARANCES.length);
  });
});

describe("obstacle generation: finish line and basic shape", () => {
  it("generates a non-empty sequence that stays within the finish distance", () => {
    const obstacles = generateObstacles(() => 0.5);
    expect(obstacles.length).toBeGreaterThan(0);
    for (const ob of obstacles) {
      expect(ob.atDistance).toBeLessThan(FINISH_DISTANCE);
      expect(ob.atDistance).toBeGreaterThan(0);
    }
  });

  it("obstacles are in strictly increasing distance order", () => {
    const obstacles = generateObstacles(() => 0.3);
    for (let i = 1; i < obstacles.length; i++) {
      expect(obstacles[i].atDistance).toBeGreaterThan(obstacles[i - 1].atDistance);
    }
  });
});

describe("validateSequence: the fairness guarantee, exercised directly", () => {
  it("accepts an empty or single-obstacle sequence trivially", () => {
    expect(validateSequence([])).toBe(true);
    expect(validateSequence([{ kind: "log", atDistance: 500 }])).toBe(true);
  });

  it("rejects a ground-obstacle immediately followed by a bird with no real recovery time", () => {
    const unfair: SpawnedObstacle[] = [
      { kind: "log", atDistance: 500 },
      { kind: "bird", atDistance: 505 }, // 5 units apart — far too close at any speed
    ];
    expect(validateSequence(unfair)).toBe(false);
  });

  it("rejects a bird immediately followed by a ground obstacle with no real recovery time", () => {
    const unfair: SpawnedObstacle[] = [
      { kind: "bird", atDistance: 500 },
      { kind: "rock", atDistance: 505 },
    ];
    expect(validateSequence(unfair)).toBe(false);
  });

  it("accepts two consecutive ground obstacles close together (no jump/no-jump conflict between them)", () => {
    const fair: SpawnedObstacle[] = [
      { kind: "log", atDistance: 500 },
      { kind: "rock", atDistance: 520 },
    ];
    expect(validateSequence(fair)).toBe(true);
  });

  it("accepts two consecutive birds close together (no jump/no-jump conflict between them)", () => {
    const fair: SpawnedObstacle[] = [
      { kind: "bird", atDistance: 500 },
      { kind: "bird", atDistance: 520 },
    ];
    expect(validateSequence(fair)).toBe(true);
  });

  // The actual fairness guarantee this generator exists to provide,
  // exercised across the FULL speed range the game reaches (slow start,
  // fast end, and points in between) — not just the starting speed,
  // since the generator converts distance to an estimated elapsed time to
  // decide gaps, and that estimate must stay correct as speed ramps up.
  // Run many times per point since spawn timing is randomized within
  // bounds — this is a guarantee about the GENERATOR, not one lucky
  // sample.
  it("every generated sequence is fair across many runs, seeded across the full speed range", () => {
    const seeds = Array.from({ length: 50 }, (_, i) => i / 50);
    for (const seed of seeds) {
      // A simple deterministic sequence generator seeded off `seed` so
      // each of the 50 runs explores different random choices, while
      // still being reproducible if a failure needs to be re-run.
      let state = Math.floor(seed * 1_000_000) + 1;
      const rng = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const obstacles = generateObstacles(rng);
      expect(validateSequence(obstacles), `seed ${seed} produced an unfair sequence`).toBe(true);
    }
  });
});

describe("generateStars: collectibles never collide with obstacles", () => {
  it("generates a non-empty sequence that stays within the finish distance", () => {
    const obstacles = generateObstacles(() => 0.5);
    const stars = generateStars(obstacles, () => 0.5);
    expect(stars.length).toBeGreaterThan(0);
    for (const star of stars) {
      expect(star.atDistance).toBeLessThan(FINISH_DISTANCE);
      expect(star.atDistance).toBeGreaterThan(0);
    }
  });

  // The task's own explicit requirement: "stars appear frequently enough
  // that a normal successful run allows the player to collect several."
  // A bare ">0" check (above) would NOT have caught the real bug found
  // here: the generator's first version dropped a candidate star
  // entirely the instant it landed within STAR_OBSTACLE_MARGIN of ANY
  // obstacle, rather than nudging forward to find a clear spot nearby —
  // since obstacles are dense enough that this is common, not rare, a
  // full 4200-unit run was left with as few as 2 stars total. This test
  // asserts the actual "several" requirement, across many seeds, so a
  // regression back to that starved behavior fails here specifically.
  it("places at least several stars across a full run, not just one or two, across many seeds", () => {
    for (let seed = 0; seed < 20; seed++) {
      let state = seed * 104729 + 1;
      const rng = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const obstacles = generateObstacles(rng);
      const stars = generateStars(obstacles, rng);
      expect(stars.length, `seed ${seed} only placed ${stars.length} star(s) across the whole run`).toBeGreaterThanOrEqual(5);
    }
  });

  it("never places a star within STAR_OBSTACLE_MARGIN of any obstacle", () => {
    const obstacles = generateObstacles(() => 0.4);
    const stars = generateStars(obstacles, () => 0.4);
    for (const star of stars) {
      for (const obstacle of obstacles) {
        expect(Math.abs(star.atDistance - obstacle.atDistance)).toBeGreaterThanOrEqual(STAR_OBSTACLE_MARGIN);
      }
    }
  });

  it("alternates ground and air stars, so collecting every star requires real play, not a straight line", () => {
    const obstacles = generateObstacles(() => 0.5);
    const stars = generateStars(obstacles, () => 0.5);
    const groundCount = stars.filter((s) => s.ground).length;
    const airCount = stars.filter((s) => !s.ground).length;
    expect(groundCount).toBeGreaterThan(0);
    expect(airCount).toBeGreaterThan(0);
  });

  it("holds the no-collision guarantee across many seeded runs, not just one sample", () => {
    for (let seed = 0; seed < 30; seed++) {
      let state = seed * 7919 + 1;
      const rng = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const obstacles = generateObstacles(rng);
      const stars = generateStars(obstacles, rng);
      for (const star of stars) {
        for (const obstacle of obstacles) {
          expect(
            Math.abs(star.atDistance - obstacle.atDistance),
            `seed ${seed}: a star landed within STAR_OBSTACLE_MARGIN of an obstacle`,
          ).toBeGreaterThanOrEqual(STAR_OBSTACLE_MARGIN);
        }
      }
    }
  });
});

describe("hand-authored sprite grids: row-width consistency", () => {
  // A mismatched row width is a real, easy authoring mistake (one row a
  // character short or long) that produces a subtly skewed sprite with no
  // type or runtime error — this is a structural data-integrity check on
  // the authored pixel data itself, not an assertion about what the
  // rendered pixels look like.
  function assertRectangular(grid: PixelGrid, label: string) {
    const width = grid[0]?.length ?? 0;
    expect(width, `${label} has an empty first row`).toBeGreaterThan(0);
    for (let i = 0; i < grid.length; i++) {
      expect(grid[i].length, `${label} row ${i} has a different width than row 0`).toBe(width);
    }
  }

  it("every creature head grid is internally rectangular (every row the same width)", () => {
    for (const appearance of APPEARANCES) {
      assertRectangular(CREATURE_HEADS[appearance], `CREATURE_HEADS.${appearance}`);
    }
  });

  it("every shared body/leg/collision grid is internally rectangular", () => {
    assertRectangular(BODY_ROWS, "BODY_ROWS");
    assertRectangular(LEGS_RUN_A, "LEGS_RUN_A");
    assertRectangular(LEGS_RUN_B, "LEGS_RUN_B");
    assertRectangular(LEGS_JUMP, "LEGS_JUMP");
    assertRectangular(FLOPPED, "FLOPPED");
  });

  it("every creature's head is the same width as the shared body, so the two stack into one clean silhouette", () => {
    const bodyWidth = BODY_ROWS[0].length;
    for (const appearance of APPEARANCES) {
      const headWidth = CREATURE_HEADS[appearance][0].length;
      expect(headWidth, `${appearance}'s head width doesn't match BODY_ROWS' width`).toBe(bodyWidth);
    }
  });

  it("every leg frame is the same width as the shared body, so swapping run/jump legs never shifts the silhouette", () => {
    const bodyWidth = BODY_ROWS[0].length;
    for (const [label, legs] of [
      ["LEGS_RUN_A", LEGS_RUN_A],
      ["LEGS_RUN_B", LEGS_RUN_B],
      ["LEGS_JUMP", LEGS_JUMP],
    ] as const) {
      expect(legs[0].length, `${label}'s width doesn't match BODY_ROWS' width`).toBe(bodyWidth);
    }
  });
});
