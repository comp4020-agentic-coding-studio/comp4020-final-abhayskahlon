import { describe, expect, it } from "vitest";
import { clockSkewMs, remainingSeconds } from "../src/components/activityCountdown";

// Regression coverage for a real bug found via playtesting: the activity
// badge's countdown computed `deadline - Date.now()` using the BROWSER's
// own clock, with no correction for that clock being wrong. A visitor
// whose system clock read even a handful of seconds off from real time saw
// a countdown that didn't match the server's own stated cooldown at all —
// reported as "19s" shown immediately after a sleep whose own history
// entry said "asleep for 8s". Reproduced directly: an 11-second-behind
// client clock against an 8-second cooldown produces exactly that "19s"
// figure with the old (unskew-corrected) arithmetic.
//
// Unlike spec/activity-countdown-resync.test.ts (a static source-check,
// since THAT fix is real browser setInterval/visibilitychange timing that
// jsdom doesn't meaningfully execute), this bug is pure arithmetic once
// extracted — src/components/activityCountdown.ts holds exactly that, with
// no DOM or timers involved, so it's tested directly and numerically here.
describe("activity countdown clock-skew correction", () => {
  it("computes a client's clock skew from the server's own render-time timestamp", () => {
    const serverNow = "2026-11-08T02:42:05.000Z";
    // This client's own clock reads 11 seconds BEHIND the server's.
    const clientNowMs = new Date("2026-11-08T02:41:54.000Z").getTime();
    expect(clockSkewMs(serverNow, clientNowMs)).toBe(-11_000);
  });

  it("the reported bug, reproduced exactly: an 11s-behind client clock against an 8s cooldown must still show ~8s, never ~19s", () => {
    const serverNow = "2026-11-08T02:42:05.000Z";
    const deadline = "2026-11-08T02:42:13.000Z"; // 8s after serverNow — SLEEP_COOLDOWN_MS's default
    const clientNowAtRenderMs = new Date("2026-11-08T02:41:54.000Z").getTime(); // 11s behind
    const skew = clockSkewMs(serverNow, clientNowAtRenderMs);

    // Right when the badge first renders: should read close to 8s, not 19s.
    expect(remainingSeconds(deadline, clientNowAtRenderMs, skew)).toBe(8);

    // A tick 4 (client-clock) seconds later should read ~4s remaining —
    // proving the skew correction holds steady across the countdown, not
    // just at the first instant.
    const fourSecondsLaterMs = clientNowAtRenderMs + 4000;
    expect(remainingSeconds(deadline, fourSecondsLaterMs, skew)).toBe(4);
  });

  it("a client clock running AHEAD of the server is corrected the same way", () => {
    const serverNow = "2026-11-08T02:42:05.000Z";
    const deadline = "2026-11-08T02:42:13.000Z"; // 8s cooldown
    const clientNowAheadMs = new Date("2026-11-08T02:42:20.000Z").getTime(); // 15s ahead
    const skew = clockSkewMs(serverNow, clientNowAheadMs);
    expect(remainingSeconds(deadline, clientNowAheadMs, skew)).toBe(8);
  });

  it("a client clock that exactly matches the server's needs no correction (skew = 0 behaves identically)", () => {
    const deadline = "2026-11-08T02:42:13.000Z";
    const now = new Date("2026-11-08T02:42:08.000Z").getTime(); // 5s before deadline
    expect(remainingSeconds(deadline, now, 0)).toBe(5);
  });

  it("never returns a negative count once the deadline has passed, regardless of skew", () => {
    const deadline = "2026-11-08T02:42:13.000Z";
    const wellAfterMs = new Date("2026-11-08T02:43:00.000Z").getTime();
    expect(remainingSeconds(deadline, wellAfterMs, 0)).toBe(0);
    expect(remainingSeconds(deadline, wellAfterMs, -20_000)).toBe(0);
    expect(remainingSeconds(deadline, wellAfterMs, 20_000)).toBe(0);
  });
});
