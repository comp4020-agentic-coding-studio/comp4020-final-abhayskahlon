// The Adventure runner's complete game logic — physics, obstacle
// generation, collision, rendering, input, and lifecycle. Deliberately a
// plain TypeScript module with zero dependencies (no canvas library, no
// game engine): PROCESS.md's own Decision 18 explains why this stays
// this small. AdventureGame.astro owns ONLY the overlay/screen markup and
// DOM visibility; every listener (keyboard, pointer, the
// visibility-change auto-pause) and the requestAnimationFrame loop live
// here, so there is exactly one place that can attach or remove them —
// never two competing handlers for the same input.
//
// This module never talks to the server, never knows about sessions,
// rooms, or `/api/adventure` — the in-game score it reports via
// `onFinish` (distance, stars collected) is purely for the result
// screen's own display text. The actual Adventure action is still the
// existing, unchanged `.activity-form.adventure-form` POST; nothing here
// ever constructs or sends a request.
import type { AppearanceId } from "../lib/creature";

// ---- physics constants -----------------------------------------------
// A small internal canvas, scaled up by CSS/device-pixel-ratio handling
// in AdventureGame.astro — these numbers are in that internal coordinate
// space, not real screen pixels.
export const CANVAS_WIDTH = 240;
export const CANVAS_HEIGHT = 135;
export const GROUND_Y = 108;

const GRAVITY = 420; // px/s^2 (internal px)
const JUMP_VELOCITY = -165; // px/s, upward (negative y)
const PLAYER_X = 36;
const PLAYER_SIZE = 16;

// Pure projectile-motion math — a jump always takes the same time and
// reaches the same height, since gravity/velocity never change at
// runtime. Used both by the simulation, by the obstacle generator's
// fairness check, and by star placement (an "air" star is positioned
// near this exact peak height so collecting it takes a real jump, not a
// guess) — one real number, never independently re-derived elsewhere.
export function jumpAirtimeSeconds(): number {
  // Time to return to y=0 under constant gravity: 2 * v / g.
  return (2 * Math.abs(JUMP_VELOCITY)) / GRAVITY;
}

export function jumpPeakHeight(): number {
  // v^2 / (2g)
  return (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
}

// ---- scroll speed -------------------------------------------------------
const START_SPEED = 90; // px/s
const MAX_SPEED = 170; // px/s
const SPEED_RAMP_PER_SECOND = 2.2; // px/s, added every second of play

export function speedAtTime(elapsedSeconds: number): number {
  return Math.min(MAX_SPEED, START_SPEED + SPEED_RAMP_PER_SECOND * elapsedSeconds);
}

// A run reaches the finish line at this distance (internal px units,
// summed scroll speed over time) — tuned against START_SPEED/MAX_SPEED so
// a competent run lands in the ~30-45s window the spec asks for.
export const FINISH_DISTANCE = 4200;

// ---- obstacles -----------------------------------------------------------
export type GroundObstacleKind = "log" | "puddle" | "rock";
export type ObstacleKind = GroundObstacleKind | "bird";

export interface SpawnedObstacle {
  kind: ObstacleKind;
  // The distance (same units as FINISH_DISTANCE) at which this obstacle's
  // leading edge reaches the player's x position — i.e. "when it must be
  // reacted to," not a spawn-off-screen time.
  atDistance: number;
}

const GROUND_KINDS: readonly GroundObstacleKind[] = ["log", "puddle", "rock"];

// Minimum real recovery time this generator must respect between any two
// obstacles whose correct responses conflict (one needs a jump, the other
// needs NOT jumping) — jump airtime plus a short, deliberately generous
// buffer so a human's reaction time is never the thing a "fair" sequence
// depends on.
const REACTION_BUFFER_SECONDS = 0.25;

function minSafeGapSeconds(): number {
  return jumpAirtimeSeconds() + REACTION_BUFFER_SECONDS;
}

// Generates a full obstacle sequence for one run, up to FINISH_DISTANCE,
// honoring minSafeGapSeconds() at the ACTUAL scroll speed each obstacle
// would be encountered at (speed only increases with elapsed time, and
// elapsed time is itself a function of distance and the speed curve so
// far — approximated here by converting the current distance to an
// elapsed-time estimate via the known speed ramp, which is exact since
// speedAtTime is monotonic and the ramp is linear-then-flat).
//
// Sequence-level fairness (not just pairwise gaps): every candidate
// obstacle is checked against the recovery window of whichever kind of
// obstacle came immediately before it, in SECONDS at the current speed,
// not in raw distance — distance-based gaps would silently shrink in
// real time as the scroll speed ramps up, exactly the kind of "fair at
// the start, unfair once it speeds up" bug this function exists to rule
// out. The same rule naturally chains across more than two obstacles,
// since each new obstacle is checked against its immediate predecessor's
// own already-validated placement.
export function generateObstacles(rng: () => number = Math.random): SpawnedObstacle[] {
  const obstacles: SpawnedObstacle[] = [];
  let distance = 300; // a short clear runway before the first obstacle
  let prevKind: ObstacleKind | null = null;

  while (distance < FINISH_DISTANCE - 200) {
    const elapsedEstimate = estimateElapsedSeconds(distance);
    const speed = speedAtTime(elapsedEstimate);

    const isBird = rng() < 0.3;
    const kind: ObstacleKind = isBird ? "bird" : GROUND_KINDS[Math.floor(rng() * GROUND_KINDS.length)];

    // Conflict only matters between a ground obstacle (forces a jump) and
    // a bird (forces NOT jumping) — two ground obstacles in a row are
    // both cleared the same way (jump), and two birds in a row are both
    // cleared the same way (don't jump), so only a kind-class CHANGE
    // needs the full recovery window; same-class obstacles only need
    // enough visual gap to read as separate obstacles, a much shorter
    // minimum.
    const prevIsGround = prevKind !== null && prevKind !== "bird";
    const thisIsGround = kind !== "bird";
    const isConflicting = prevKind !== null && prevIsGround !== thisIsGround;

    // A conflicting gap is sized against MAX_SPEED, not the speed at
    // THIS point in the ramp — speed only ever increases with distance,
    // so by the time the player actually reaches the next obstacle the
    // real speed could be higher than it is right now, which would
    // shrink the REAL-TIME gap below the safe minimum even though the
    // DISTANCE gap looked sufficient when it was chosen. Sizing against
    // the worst-case (fastest) speed the run can ever reach guarantees
    // the real-time gap is always >= minSafeGapSeconds(), regardless of
    // where in the ramp this obstacle falls.
    const minGapSeconds = isConflicting ? minSafeGapSeconds() : 0.45;
    const minGapDistance = minGapSeconds * (isConflicting ? MAX_SPEED : speed);

    distance += minGapDistance + rng() * 220;
    obstacles.push({ kind, atDistance: distance });
    prevKind = kind;
  }

  return obstacles;
}

// Inverse of the speed ramp: how long (in seconds) it takes to cover
// `distance` given START_SPEED ramping linearly up to MAX_SPEED. Used
// only to estimate "what speed will the player be moving at when they
// reach this obstacle," which is what the fairness check actually cares
// about — not wall-clock accuracy during real play (the live game loop
// tracks its own elapsed time directly; this is a planning-time estimate
// used purely to choose safe gaps).
function estimateElapsedSeconds(distance: number): number {
  const rampSeconds = (MAX_SPEED - START_SPEED) / SPEED_RAMP_PER_SECOND;
  const rampDistance = START_SPEED * rampSeconds + 0.5 * SPEED_RAMP_PER_SECOND * rampSeconds * rampSeconds;
  if (distance <= rampDistance) {
    // Solve START_SPEED*t + 0.5*ramp*t^2 = distance for t (quadratic).
    const a = 0.5 * SPEED_RAMP_PER_SECOND;
    const b = START_SPEED;
    const c = -distance;
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }
  return rampSeconds + (distance - rampDistance) / MAX_SPEED;
}

// Re-validates an already-generated sequence end-to-end: for every
// consecutive pair whose obstacle KIND CLASS differs (ground vs. bird),
// the real time gap between them (at the speed each one is actually
// encountered at) must be at least minSafeGapSeconds(). Exported
// separately from generateObstacles so tests can assert the GUARANTEE
// independently of the generator's own internal bookkeeping — this is
// the actual fairness contract, generateObstacles is just one (trusted,
// but independently checked) way of satisfying it.
export function validateSequence(obstacles: readonly SpawnedObstacle[]): boolean {
  for (let i = 1; i < obstacles.length; i++) {
    const prev = obstacles[i - 1];
    const curr = obstacles[i];
    const prevIsGround = prev.kind !== "bird";
    const currIsGround = curr.kind !== "bird";
    if (prevIsGround === currIsGround) continue; // same class, no jump/no-jump conflict

    const speed = speedAtTime(estimateElapsedSeconds(curr.atDistance));
    const gapSeconds = (curr.atDistance - prev.atDistance) / speed;
    if (gapSeconds < minSafeGapSeconds()) return false;
  }
  return true;
}

// ---- collision -----------------------------------------------------------
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---- collectible stars ----------------------------------------------------
// A second, independent spawn list — purely cosmetic runtime state, never
// sent to or validated by the server, and never part of obstacle
// fairness (a missed star is never a collision). Generated separately
// from generateObstacles() but checked against it so a star never lands
// in the same spot as an obstacle.
export interface SpawnedStar {
  atDistance: number;
  // Ground stars sit at running height (collected just by passing
  // through); air stars sit near a jump's peak height, so collecting
  // every star in a run takes real play, not just holding a straight
  // line.
  ground: boolean;
}

const STAR_GAP = 260;
const STAR_GAP_JITTER = 120;
export const STAR_OBSTACLE_MARGIN = 60;
// How far a candidate star position is allowed to nudge forward, in
// small steps, looking for a spot clear of every obstacle, before giving
// up on that slot entirely. Obstacles land roughly every ~150-200 units
// on average (generateObstacles' own gap sizing), each excluding a
// STAR_OBSTACLE_MARGIN-wide band — a single untried candidate position
// landing inside that band is common, not rare, so without retrying
// nearby the generator starves itself down to just one or two stars for
// an entire run (confirmed directly: simulating the real generator
// output left only 2 stars across a full 4200-unit run before this fix).
const STAR_NUDGE_STEP = 15;
const STAR_MAX_NUDGES = 12;

function isClearOfObstacles(distance: number, obstacles: readonly SpawnedObstacle[]): boolean {
  return obstacles.every((o) => Math.abs(o.atDistance - distance) >= STAR_OBSTACLE_MARGIN);
}

export function generateStars(obstacles: readonly SpawnedObstacle[], rng: () => number = Math.random): SpawnedStar[] {
  const stars: SpawnedStar[] = [];
  let distance = 500;
  let groundNext = true;
  while (distance < FINISH_DISTANCE - 150) {
    // Try the candidate position, then nudge forward in small steps
    // looking for a clear spot — never backward, so stars stay in
    // increasing distance order — rather than abandoning this slot
    // outright the instant it happens to land near an obstacle.
    let candidate = distance;
    let placed = false;
    for (let attempt = 0; attempt <= STAR_MAX_NUDGES; attempt++) {
      if (isClearOfObstacles(candidate, obstacles)) {
        stars.push({ atDistance: candidate, ground: groundNext });
        groundNext = !groundNext;
        placed = true;
        break;
      }
      candidate += STAR_NUDGE_STEP;
    }
    distance = (placed ? candidate : distance) + STAR_GAP + rng() * STAR_GAP_JITTER;
  }
  return stars;
}

// ---- appearance sprite identity ------------------------------------------
// One small palette per appearance, chosen to echo each creature
// component's own real body color (src/components/*.astro's --*-body
// custom properties) without tracing or scaling that SVG art — a new,
// simple, blocky identity in the same spirit, not a miniature of it.
export interface SpritePalette {
  body: string;
  accent: string;
  light: string;
}

export const SPRITE_PALETTES: Record<AppearanceId, SpritePalette> = {
  milo: { body: "#f0b374", accent: "#8a5a34", light: "#fbe3c4" }, // warm tan body, dark floppy ears, cream muzzle
  plip: { body: "#2b2f36", accent: "#f4b942", light: "#f2f2ea" }, // dark penguin body, orange beak/feet, white belly
  bella: { body: "#e8a6c1", accent: "#6b4a5a", light: "#fbe6ee" }, // pink kitten body, dark ear tips, pale muzzle
  simbaa: { body: "#f5ede0", accent: "#caa06a", light: "#ffffff" }, // cream wool, tan face, white wool highlight
  oliver: { body: "#d8d3c8", accent: "#9c8f78", light: "#efece6" }, // grey-cream rabbit, darker long ears, pale belly
};

export function spritePaletteFor(appearance: AppearanceId): SpritePalette {
  return SPRITE_PALETTES[appearance];
}

// ---- pixel-grid drawing -------------------------------------------------
// The one shared primitive every hand-authored sprite (creatures,
// obstacles, the star) is drawn through — a grid is just rows of single
// characters, each mapped through a small palette to a real color and
// filled one cell at a time. No image decoding, no spritesheet file, no
// new dependency: this is the same ctx.fillRect the previous prototype
// used, just organised as data instead of one-off draw calls, which is
// what makes reusing a body shape across five creatures (below) possible
// at all.
export type PixelGrid = readonly string[];
const CELL = 2; // internal canvas px per grid cell

function drawPixelGrid(ctx: CanvasRenderingContext2D, grid: PixelGrid, palette: Record<string, string>, x: number, y: number): void {
  for (let row = 0; row < grid.length; row++) {
    const line = grid[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      const color = palette[ch];
      if (!color) continue; // "." (transparent) or an unmapped char
      ctx.fillStyle = color;
      ctx.fillRect(x + col * CELL, y + row * CELL, CELL, CELL);
    }
  }
}

function gridWidth(grid: PixelGrid): number {
  return grid[0]?.length ?? 0;
}
function gridHeight(grid: PixelGrid): number {
  return grid.length;
}

const EYE = "#2b2420"; // shared dark eye color, matches --color-text

// ---- creature sprites: one small HEAD shape per appearance, everything
// else (body, legs, the collision pose) shared and reused -----------------
// The head is deliberately where each appearance's identity lives — the
// floppy ears / rounded penguin head / pointed kitten ears / woolly lamb
// bumps / long rabbit ears the task asks for — since the body and legs
// read the same across a small quadruped-ish silhouette regardless of
// species. Every row below is exactly 11 characters; a dedicated pure
// test (spec/adventure-game.test.ts) asserts this for every grid here,
// since a mismatched row width is a real, easy authoring mistake that
// would otherwise only show up as a subtly skewed sprite.
// Floppy ears are the whole identity cue here, so they're drawn
// genuinely DROOPING — narrow near the top of the head, widening as they
// fall past the head's own bottom edge — rather than flanking the face
// at eye height, which (confirmed by actually rendering an earlier
// draft) read as raised arms, not ears. Same 11-char width as every
// other grid (checked by the row-width test below); the droop is
// expressed by giving the ears MORE ROWS than the face needs, not by
// widening the grid.
const HEAD_MILO: PixelGrid = [
  "....BBB....",
  ".A.BBBBB.A.",
  "AA.BEBEB.AA",
  "AA.BBLBB.AA",
  ".A..LLL..A.",
  ".A..LAL..A.",
  "..A.....A..",
];

const HEAD_PLIP: PixelGrid = ["....BBB....", "...BBBBB...", "..BBEBEBB..", "..BLAAALB..", ".ABLLLLLBA.", ".ABLLLLLBA."];

const HEAD_BELLA: PixelGrid = ["..A.....A..", ".AAA...AAA.", ".ABBBBBBBA.", "A.BEBBBEB.A", "A.BLLLLLB.A", "..BBLALBB.."];

const HEAD_SIMBAA: PixelGrid = [".B.B.B.B.B.", "BBBBBBBBBBB", "BBAALLLAABB", "BBALELELABB", "BBAALLLAABB", ".BB.BBB.BB."];

const HEAD_OLIVER: PixelGrid = ["..A.....A..", "..A.....A..", "..A.....A..", ".ABBBBBBBA.", "..BEBBBEB..", "..BLLALLB.."];

// Exported for spec/adventure-game.test.ts's row-width consistency check
// — a mismatched row width is a real, easy authoring mistake (one row a
// character short or long) that otherwise only shows up as a subtly
// skewed sprite, never a type or runtime error.
export const CREATURE_HEADS: Record<AppearanceId, PixelGrid> = {
  milo: HEAD_MILO,
  plip: HEAD_PLIP,
  bella: HEAD_BELLA,
  simbaa: HEAD_SIMBAA,
  oliver: HEAD_OLIVER,
};

// Shared across every appearance — identity lives in the head above, not
// here, so one body shape (fed through each creature's own palette) is
// reused for all five rather than hand-authoring five near-identical
// torsos. Exported alongside the leg frames and FLOPPED below for the
// same row-width consistency check CREATURE_HEADS gets.
export const BODY_ROWS: PixelGrid = [".BBBBBBBBB.", ".BBBLLLBBB.", ".BBBBBBBBB.", "..BBBBBBB.."];

// Two alternating leg stances for the running cycle, plus a tucked
// (mostly-transparent) pair for the jump pose — swapped under the SAME
// head+body shape, which is what makes "two alternating running frames"
// and "a distinct jumping pose" cheap to produce consistently across all
// five appearances.
export const LEGS_RUN_A: PixelGrid = ["...AA.AA...", "...A...A..."];
export const LEGS_RUN_B: PixelGrid = ["..AA...AA..", "...A...A..."];
export const LEGS_JUMP: PixelGrid = ["...........", "..........."];

// A single shared "flopped over" collision pose, colored per-creature via
// the same palette every other pose uses — the task's own requirement is
// a visible, distinct game-over pose to exist at all, not a uniquely
// hand-posed fall for each of the five animals, so one wider/shorter
// silhouette (legs splayed, eyes closed) reused across all five keeps
// this maintainable while still being genuinely creature-colored and
// clearly different from every running/jumping frame.
export const FLOPPED: PixelGrid = [".....BBB.....", "....BBBBB....", "...BBE.EBB...", "AA.BLLLLLB.AA", ".A..BBBBB..A.", "............."];

function frameFor(appearance: AppearanceId, legs: PixelGrid): PixelGrid {
  return [...CREATURE_HEADS[appearance], ...BODY_ROWS, ...legs];
}

function creaturePaletteMap(p: SpritePalette): Record<string, string> {
  return { B: p.body, A: p.accent, L: p.light, E: EYE };
}

function drawCreature(ctx: CanvasRenderingContext2D, appearance: AppearanceId, bottomY: number, centerX: number, pose: "run1" | "run2" | "jump" | "collision"): void {
  const palette = creaturePaletteMap(spritePaletteFor(appearance));
  const grid =
    pose === "collision"
      ? FLOPPED
      : frameFor(appearance, pose === "jump" ? LEGS_JUMP : pose === "run1" ? LEGS_RUN_A : LEGS_RUN_B);
  const w = gridWidth(grid) * CELL;
  const h = gridHeight(grid) * CELL;
  drawPixelGrid(ctx, grid, palette, centerX - w / 2, bottomY - h);
}

// ---- obstacle sprites -----------------------------------------------------
// Each grid is sized so gridWidth*CELL / gridHeight*CELL exactly matches
// the existing collision rect dimensions for that obstacle kind (14x10
// for log/rock, 14x4 for puddle, 14x6 for the bird) — only what gets
// drawn at those coordinates changes here, never the hitbox numbers
// frame() already computes.
const LOG_GRID: PixelGrid = [".LLBBB.", "LABABBB", "LAABABB", "LABABBB", ".LLBBB."];
const LOG_PALETTE = { B: "#8a5a34", A: "#6b4423", L: "#c9975f" };

const ROCK_GRID: PixelGrid = ["..BBB..", ".BBBBB.", "BLBBBAB", "BBBBBBB", ".BBBBB."];
const ROCK_PALETTE = { B: "#8a8a8a", L: "#b9b9b9", A: "#5f5f5f" };

const PUDDLE_GRID: PixelGrid = [".BBBBB.", "BBBLBBB"];
const PUDDLE_PALETTE = { B: "#3d8ab8", L: "#8fd0ec" };

// A classic simple "chevron" bird silhouette — two wing strokes meeting
// at a small body, alternating between wings-up and wings-down for the
// flap cycle. The first version of this sprite (an abstract blob of
// disconnected cells) was confirmed, by actually rendering it in
// isolation at gameplay size, to read as nothing recognizable at all —
// this shape is deliberately as simple as a bird silhouette can be,
// prioritizing "reads as a bird at a glance" over detail.
const BIRD_WINGS_UP: PixelGrid = ["A.....A", ".A...A.", "..ABA..", "...B..."];
const BIRD_WINGS_DOWN: PixelGrid = [".......", "A.....A", ".AABAA.", "...B..."];
const BIRD_PALETTE = { A: "#3a3a42", B: "#6b6b73" };

function drawObstacleSprite(ctx: CanvasRenderingContext2D, kind: ObstacleKind, x: number, y: number, wingFrame: boolean): void {
  if (kind === "bird") {
    drawPixelGrid(ctx, wingFrame ? BIRD_WINGS_UP : BIRD_WINGS_DOWN, BIRD_PALETTE, x, y);
    return;
  }
  if (kind === "log") drawPixelGrid(ctx, LOG_GRID, LOG_PALETTE, x, y);
  else if (kind === "rock") drawPixelGrid(ctx, ROCK_GRID, ROCK_PALETTE, x, y);
  else drawPixelGrid(ctx, PUDDLE_GRID, PUDDLE_PALETTE, x, y);
}

// ---- star sprite -----------------------------------------------------------
const STAR_GRID: PixelGrid = [".A.", "AAA", ".A."];
const STAR_PALETTE = { A: "#ffd84d" };
// A near-white, near-opaque color was barely visible against the pale
// sky (confirmed by actually screenshotting a real collection) — a
// bright orange-gold reads clearly against both the sky and the ground.
const SPARKLE_PALETTE = { A: "#ff9d2e" };

// ---- the runtime loop ------------------------------------------------------
export interface AdventureGameResult {
  outcome: "success" | "collision";
  distance: number;
  collected: number;
}

export interface AdventureGameCallbacks {
  onFinish: (result: AdventureGameResult) => void;
  onHudUpdate?: (hud: { distance: number; collected: number }) => void;
  onPauseChange?: (paused: boolean) => void;
}

export interface AdventureGameController {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  isPaused: () => boolean;
}

// Starts a full run against a real <canvas>. Every listener this function
// adds (keydown, pointerdown/touchstart, visibilitychange) is removed by
// the returned controller's stop() — the ONE teardown path.
// AdventureGame.astro never adds its own input listeners; it only reacts
// to the callbacks above and calls pause()/resume()/stop().
export function startAdventureGame(
  canvas: HTMLCanvasElement,
  appearance: AppearanceId,
  callbacks: AdventureGameCallbacks,
): AdventureGameController {
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.imageSmoothingEnabled = false;

  const obstacles = generateObstacles();
  const stars = generateStars(obstacles).map((s) => ({ ...s, collected: false }));
  let obstacleIndex = 0;

  let distance = 0;
  let elapsed = 0;
  let playerY = 0; // 0 = on the ground, negative = airborne (canvas y-up offset)
  let playerVy = 0;
  let airborne = false;
  let collected = 0;
  let running = true;
  let paused = false;
  let rafHandle = 0;
  let lastFrameTime = 0;
  let finished = false;
  let collisionHoldTimer: ReturnType<typeof setTimeout> | undefined;

  const sparkles: { x: number; y: number; ttl: number }[] = [];
  const SPARKLE_MAX_TTL = 24; // ~0.4s at 60fps — long enough to actually notice

  function jump() {
    if (!running || paused || finished || airborne) return;
    airborne = true;
    playerVy = JUMP_VELOCITY;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code === "Space" || e.code === "ArrowUp") {
      // Stop the page from scrolling on Space while the game owns input —
      // the one DOM side-effect this module is responsible for preventing.
      e.preventDefault();
      jump();
    }
  }
  function onPointerDown() {
    jump();
  }
  function onVisibilityChange() {
    if (document.hidden) pause();
  }

  window.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("touchstart", onPointerDown, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);

  function finish(outcome: "success" | "collision") {
    if (finished) return;
    finished = true;
    running = false;
    callbacks.onFinish({ outcome, distance: Math.round(distance), collected });
  }

  function pause() {
    if (!running || finished || paused) return;
    paused = true;
    callbacks.onPauseChange?.(true);
  }
  function resume() {
    if (!running || finished || !paused) return;
    paused = false;
    lastFrameTime = performance.now();
    callbacks.onPauseChange?.(false);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(rafHandle);
    // Guards the collision-pose hold below: if the player exits (or the
    // overlay otherwise closes) during that brief window, the pending
    // onFinish("collision") must never fire afterward and flip the
    // screen back to a result the player already backed out of.
    clearTimeout(collisionHoldTimer);
    window.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("touchstart", onPointerDown);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  // ---- environment: clouds, a distant tree line, and a textured ground —
  // all plain fillRect composition (no grids needed for these), drawn
  // fresh every frame from the current `distance` so they scroll in step
  // with everything else. Deliberately restrained: a handful of shapes,
  // not hand-placed scenery, per the task's own "avoid elaborate scenery"
  // constraint.
  const CLOUDS = [
    { baseX: 30, y: 16 },
    { baseX: 120, y: 11 },
    { baseX: 205, y: 24 },
  ];
  function mod(n: number, m: number): number {
    return ((n % m) + m) % m;
  }
  function drawEnvironment() {
    if (!ctx) return;
    ctx.fillStyle = "#cdeefb";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Clouds: slow parallax (a fraction of ground speed), wrapping
    // smoothly around the canvas width.
    ctx.fillStyle = "#ffffff";
    for (const cloud of CLOUDS) {
      const x = mod(cloud.baseX - distance * 0.15, CANVAS_WIDTH + 40) - 20;
      ctx.fillRect(x, cloud.y, 12, 5);
      ctx.fillRect(x + 4, cloud.y - 3, 8, 4);
      ctx.fillRect(x - 3, cloud.y + 2, 6, 3);
    }

    // Distant tree line: a muted-green jagged band, faster than the
    // clouds but still slower than the real foreground scroll speed.
    // Drawn all the way down to groundTopY (not just to GROUND_Y) so it
    // sits flush behind the ground layer with no visible sky gap between
    // the hill band and the terrain — confirmed by an earlier render
    // where a plain strip of sky showed through between the two.
    const groundTopY = GROUND_Y + PLAYER_SIZE;
    const tileWidth = 20;
    const heights = [10, 14, 8, 16, 12];
    const hillOffset = mod(distance * 0.4, tileWidth);
    ctx.fillStyle = "#6fa86a";
    for (let x = -tileWidth; x < CANVAS_WIDTH + tileWidth; x += tileWidth) {
      const tileIndex = Math.floor((x + distance * 0.4) / tileWidth);
      const h = heights[((tileIndex % heights.length) + heights.length) % heights.length];
      ctx.fillRect(x - hillOffset, GROUND_Y - h, tileWidth, groundTopY - (GROUND_Y - h));
    }

    // Ground: soil band, a grass layer, small jagged tufts, and the
    // occasional flower — all at the real (full) scroll speed, since
    // this is the terrain the player is actually running over.
    ctx.fillStyle = "#6b4a2f";
    ctx.fillRect(0, groundTopY + 6, CANVAS_WIDTH, CANVAS_HEIGHT - (groundTopY + 6));
    ctx.fillStyle = "#7fcf6a";
    ctx.fillRect(0, groundTopY, CANVAS_WIDTH, 10);

    const tuftSpacing = 8;
    const tuftOffset = mod(distance, tuftSpacing);
    ctx.fillStyle = "#6fc25c";
    for (let x = -tuftSpacing; x < CANVAS_WIDTH + tuftSpacing; x += tuftSpacing) {
      ctx.fillRect(x - tuftOffset, groundTopY - 3, 2, 4);
    }

    const flowerSpacing = 37;
    for (let x = -flowerSpacing; x < CANVAS_WIDTH + flowerSpacing; x += flowerSpacing) {
      const worldTile = Math.floor((x + distance) / flowerSpacing);
      if (((worldTile % 5) + 5) % 5 !== 0) continue; // sparse: roughly one in five tiles
      const screenX = x - mod(distance, flowerSpacing);
      ctx.fillStyle = "#f0a8c8";
      ctx.fillRect(screenX, groundTopY - 5, 2, 2);
    }
  }

  function render(hit: boolean) {
    if (!ctx) return;
    drawEnvironment();

    // Stars: only the ones still uncollected and currently on-screen.
    for (const star of stars) {
      if (star.collected) continue;
      const screenX = PLAYER_X + (star.atDistance - distance);
      if (screenX < -10 || screenX > CANVAS_WIDTH + 10) continue;
      const y = star.ground ? GROUND_Y + PLAYER_SIZE - 12 : GROUND_Y - jumpPeakHeight() - 2;
      drawPixelGrid(ctx, STAR_GRID, STAR_PALETTE, screenX - 3, y);
    }

    // Sparkles: a brief, decaying collection effect — four bright
    // 2x2-cell bursts that spread outward and fade over a handful of
    // frames, then remove themselves. No new timers: ttl is just
    // decremented alongside the frame loop that's already running. A
    // first version drew single 2x2px cells, which (confirmed by
    // actually screenshotting a collection) was too small to reliably
    // notice against the sky at normal gameplay speed — these are drawn
    // as small filled squares instead, directly with fillRect (not
    // through the 1-character-wide drawPixelGrid helper, which isn't a
    // good fit for a burst that needs to grow).
    ctx.fillStyle = SPARKLE_PALETTE.A;
    for (const sparkle of sparkles) {
      const spread = 1 - sparkle.ttl / SPARKLE_MAX_TTL;
      const r = 2 + spread * 6;
      const size = 3;
      ctx.fillRect(sparkle.x - r - size / 2, sparkle.y - r - size / 2, size, size);
      ctx.fillRect(sparkle.x + r - size / 2, sparkle.y - r - size / 2, size, size);
      ctx.fillRect(sparkle.x - r - size / 2, sparkle.y + r - size / 2, size, size);
      ctx.fillRect(sparkle.x + r - size / 2, sparkle.y + r - size / 2, size, size);
    }

    // Obstacles — same scrolling loop as before, now drawing a real
    // sprite at each kind's existing position/size instead of a flat
    // rect.
    const wingFrame = Math.floor(elapsed * 6) % 2 === 0;
    for (let i = obstacleIndex; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const screenX = PLAYER_X + (ob.atDistance - distance);
      if (screenX > CANVAS_WIDTH) break;
      if (screenX < -20) continue;
      const y = ob.kind === "bird" ? GROUND_Y - 40 : GROUND_Y - (ob.kind === "puddle" ? 4 : 10) + PLAYER_SIZE;
      drawObstacleSprite(ctx, ob.kind, screenX, y, wingFrame);
    }

    // Player — run cycle alternates on a fixed short timer (so it reads
    // as a walk regardless of scroll speed), jump pose while airborne,
    // the shared flopped pose on the frame a collision is detected.
    const bottomY = GROUND_Y + playerY + PLAYER_SIZE;
    const centerX = PLAYER_X + PLAYER_SIZE / 2;
    const pose = hit ? "collision" : airborne ? "jump" : Math.floor(elapsed * 8) % 2 === 0 ? "run1" : "run2";
    drawCreature(ctx, appearance, bottomY, centerX, pose);
  }

  function frame(now: number) {
    if (!running) return;
    rafHandle = requestAnimationFrame(frame);
    if (paused) {
      lastFrameTime = now;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000 || 0);
    lastFrameTime = now;
    elapsed += dt;

    const speed = speedAtTime(elapsed);
    distance += speed * dt;

    if (airborne) {
      playerVy += GRAVITY * dt;
      playerY += playerVy * dt;
      if (playerY >= 0) {
        playerY = 0;
        playerVy = 0;
        airborne = false;
      }
    }

    // Advance past any obstacle the player has already fully cleared, and
    // check collision against the one currently in range.
    while (obstacleIndex < obstacles.length && obstacles[obstacleIndex].atDistance + 20 < distance) {
      obstacleIndex++;
    }
    const current = obstacles[obstacleIndex];
    const playerRect: Rect = { x: PLAYER_X, y: GROUND_Y + playerY, w: PLAYER_SIZE, h: PLAYER_SIZE };
    if (current && Math.abs(current.atDistance - distance) < 16) {
      const obstacleRect: Rect =
        current.kind === "bird"
          ? { x: PLAYER_X, y: GROUND_Y - 40, w: 14, h: 6 }
          : { x: PLAYER_X, y: GROUND_Y + PLAYER_SIZE - (current.kind === "puddle" ? 4 : 10), w: 14, h: current.kind === "puddle" ? 4 : 10 };
      if (rectsOverlap(playerRect, obstacleRect)) {
        // Render WITH the collision pose, then hold on that frame for a
        // beat before actually finishing — calling finish() (which
        // AdventureGame.astro responds to by immediately swapping the
        // canvas out for the result screen) in the very same tick as
        // this render would mean the browser never actually paints the
        // collision pose at all; a human playing would never see it.
        // Found by trying to screenshot it: with no delay, every
        // attempted capture landed on the result screen instead, no
        // matter how tightly polled.
        running = false; // stop advancing the simulation immediately
        cancelAnimationFrame(rafHandle);
        render(true);
        collisionHoldTimer = setTimeout(() => finish("collision"), 450);
        return;
      }
    }

    // Stars: independent of obstacle collision — a miss is never a
    // collision, just an uncollected star. Checked at the same
    // "currently at the player's position" line obstacles already use.
    for (const star of stars) {
      if (star.collected || Math.abs(star.atDistance - distance) >= 14) continue;
      const starY = star.ground ? GROUND_Y + PLAYER_SIZE - 12 : GROUND_Y - jumpPeakHeight() - 2;
      const starRect: Rect = { x: PLAYER_X, y: starY, w: 6, h: 6 };
      if (rectsOverlap(playerRect, starRect)) {
        star.collected = true;
        collected++;
        sparkles.push({ x: PLAYER_X + PLAYER_SIZE / 2, y: starY, ttl: SPARKLE_MAX_TTL });
      }
    }
    for (let i = sparkles.length - 1; i >= 0; i--) {
      sparkles[i].ttl--;
      if (sparkles[i].ttl <= 0) sparkles.splice(i, 1);
    }

    if (distance >= FINISH_DISTANCE) {
      finish("success");
      return;
    }

    callbacks.onHudUpdate?.({ distance: Math.round(distance), collected });
    render(false);
  }

  lastFrameTime = performance.now();
  rafHandle = requestAnimationFrame(frame);

  return {
    pause,
    resume,
    stop,
    isPaused: () => paused,
  };
}
