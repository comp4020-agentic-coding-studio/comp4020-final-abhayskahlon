import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for a real bug found via human playtesting (PROCESS.md,
// Incident 4): the activity badge's countdown is a separate, client-only
// clock (attachActivityCountdown() in src/pages/index.astro), ticking down
// from a timestamp the server sent once, with no mechanism of its own to
// ever ask the server again. Two symptoms, both caused by the same gap:
//
// 1. Reaching zero only ever changed displayed text — it never actually
//    asked the server whether the creature had woken up, so the badge (and
//    the sleeping creature art) sat on "is waking up…" indefinitely until
//    something UNRELATED (another action, a reload, an SSE event from
//    someone else) happened to trigger a resync.
// 2. Two tabs that attached their own countdown at different moments, or a
//    tab backgrounded long enough for the browser to throttle its timers,
//    had no way to converge on the same remaining-seconds number, since
//    neither had any reason to recheck the real server state on its own.
//
// Honest limitation, the same one spec/action-form-url.test.ts already
// states for its own bug class: this is `setInterval`/`EventSource`/
// `visibilitychange` timing behaviour in a real browser tab, which jsdom
// (this project's only DOM engine) does not meaningfully execute the way a
// real tab does — there is no real wall-clock `setInterval` to let run, and
// no real browser-throttling-while-hidden behaviour to reproduce. Real
// reproduction (an un-nudged countdown reaching zero and staying on
// "waking up…" with no action taken; a visibility-restore resync on an
// already-expired cooldown) was done directly against a live browser
// session, recorded in PROCESS.md's Incident 4, not here. What this file
// CAN do, and does: read src/pages/index.astro as plain text and assert the
// two specific structural properties that are the actual fix — a
// regression back to either pattern would silently reintroduce one of the
// two symptoms even though no HTTP-level or jsdom-level spec test here
// would ever notice, since none of them run a real client-side timer loop
// or fire a real visibilitychange event.
const SOURCE_PATH = "src/pages/index.astro";

describe("activity countdown resync (Incident 4)", () => {
  it("the countdown resyncs with the server once it reaches zero, rather than only changing its own displayed text", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    // The exact gap that let a tab sit on "is waking up…" forever: the
    // function existed, and its `remaining <= 0` branch existed, but it
    // never called back into the one thing that asks the server again.
    const tickFnMatch = source.match(/const tick = \(\) => \{[\s\S]*?\n {8}\};/);
    expect(tickFnMatch, "expected to find the countdown's tick() function in src/pages/index.astro").not.toBeNull();
    const tickFnSource = tickFnMatch![0];
    expect(tickFnSource).toMatch(/remaining <= 0/);
    expect(
      tickFnSource,
      "the countdown reaching zero must trigger refreshLiveState() — otherwise the badge (and the sleeping creature art) can be left stuck on a client-only guess with no path back to the server's real state",
    ).toMatch(/refreshLiveState\(\)/);
  });

  it("a tab resyncs when it becomes visible again, so a backgrounded tab can never silently drift from the server's real state", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(
      source,
      "expected a visibilitychange listener that calls refreshLiveState() when the tab becomes visible — without it, a tab backgrounded past the cooldown (or one that simply missed an SSE event) has no way to ever resync on its own",
    ).toMatch(/visibilitychange["'][\s\S]{0,400}?refreshLiveState\(\)/);
  });
});
