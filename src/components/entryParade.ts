// A small decorative animation for the entry page's sky banner: the five
// selectable appearances (src/lib/creature.ts's APPEARANCES) running
// left-to-right in a single-file line. Built entirely by reusing the
// Adventure runner's own pixel-art creature sprite and drawing code
// (drawCreature, src/components/adventureGame.ts) — no second copy of the
// same five creatures' art is authored here, only a small independent
// animation loop that calls the same function Decision 18's runner does.
//
// Purely cosmetic: no stats, no server call, no relation to the real
// Adventure minigame beyond sharing its drawing primitive. If this script
// never runs (JS disabled/blocked), the canvas stays empty and transparent
// — the sky, clouds, grass, and "COMMONS" title beneath/around it (all
// plain CSS) are unaffected, the same stated, accepted degradation this
// project's own accessibility audit already describes for its "● live"
// indicator.
import { drawCreature, SPRITE_PALETTES } from "./adventureGame";
import type { AppearanceId } from "../lib/creature";

// Deliberately NOT `import { APPEARANCES } from "../lib/creature"`: that
// module reads `process.env.SLEEP_COOLDOWN_MS` at top level (a Node-only
// global, src/lib/creature.ts), which is absent in a browser bundle and
// throws the moment this script's import graph touches it — confirmed by
// actually hitting that exact "process is not defined" error with an
// earlier draft of this file. adventureGame.ts already sidesteps this the
// same way (importing AppearanceId as a type only), so its own
// already-browser-safe SPRITE_PALETTES — which already enumerates the
// same five ids, in the same order — is the one used here too, keeping a
// single source of truth rather than a second hardcoded list.
const APPEARANCE_ORDER = Object.keys(SPRITE_PALETTES) as AppearanceId[];

const SPEED = 26; // px/s, in the canvas's own CSS-pixel coordinate space
const SPACING = 48; // horizontal gap between each creature's running position

export interface EntryParadeController {
  stop: () => void;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Sized to the canvas's actual on-screen CSS pixels (set once at start,
// not re-measured on resize — a decorative animation redrawing at a
// slightly stale size after an orientation change is a cosmetic
// non-issue, not worth a ResizeObserver for). drawCreature's own sprite
// cells stay a fixed size regardless of container width, so the five
// creatures read as small running figures along the banner's own ground
// line rather than being stretched to fill it.
export function startEntryParade(canvas: HTMLCanvasElement): EntryParadeController {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { stop: () => {} };

  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = false;

  const order = APPEARANCE_ORDER;
  const trackLength = order.length * SPACING;
  const groundY = height - 6; // leaves room for the grass strip beneath

  function draw(distance: number, pose: "run1" | "run2") {
    ctx!.clearRect(0, 0, width, height);
    order.forEach((appearance, i) => {
      const x = mod(i * SPACING + distance, trackLength + width + SPACING) - SPACING;
      drawCreature(ctx!, appearance, groundY, x, pose);
    });
  }

  // A canvas animation loop ignores CSS's `animation-duration` override
  // entirely — the site-wide prefers-reduced-motion rule (src/styles.css)
  // has nothing to neutralise here, so this checks the same media query
  // directly and, when it matches, draws one still frame instead of ever
  // starting requestAnimationFrame.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    draw(0, "run1");
    return { stop: () => {} };
  }

  let distance = 0;
  let running = true;
  let rafHandle = 0;
  let lastTime = performance.now();

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min(0.1, (now - lastTime) / 1000 || 0);
    lastTime = now;
    distance += dt * SPEED;
    draw(distance, Math.floor(distance / 6) % 2 === 0 ? "run1" : "run2");
    rafHandle = requestAnimationFrame(frame);
  }

  // Same pause-while-hidden courtesy the Adventure runner's own loop
  // already follows (adventureGame.ts) — a backgrounded tab shouldn't
  // keep spending frames on a decoration nobody can see.
  function onVisibilityChange() {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(rafHandle);
    } else if (!running) {
      running = true;
      lastTime = performance.now();
      rafHandle = requestAnimationFrame(frame);
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  rafHandle = requestAnimationFrame(frame);

  return {
    stop: () => {
      running = false;
      cancelAnimationFrame(rafHandle);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
