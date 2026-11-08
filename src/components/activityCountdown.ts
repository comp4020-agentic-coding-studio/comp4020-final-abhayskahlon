// The activity badge's countdown arithmetic, pulled out of the inline
// <script> in src/pages/index.astro so it's directly unit-testable rather
// than only checkable via a static source-pattern match (this project's
// existing fallback for genuinely browser-only behaviour — see
// spec/action-form-url.test.ts). Pure and deterministic given its inputs,
// the same "pull real logic out of the component, test it directly" shape
// src/components/age.ts and src/components/adventureGame.ts already use.
//
// Real bug this guards (found via playtesting): the countdown was
// originally computed as `deadline - Date.now()`, trusting the browser's
// own clock completely. A visitor whose system clock reads even a handful
// of seconds off from real time saw a countdown that didn't match the
// server's own stated cooldown at all (reported: "19s" shown for an
// 8-second sleep — an 11-second-behind client clock, confirmed by directly
// reproducing it with a simulated clock offset). The fix: anchor to the
// server's own clock, not the browser's — `remainingSeconds()` takes the
// server's render-time timestamp and computes this client's offset from it
// ONCE, so a wrong local clock changes nothing about how many seconds are
// actually counted down.
export function clockSkewMs(serverNow: string, clientNowMs: number): number {
  return clientNowMs - new Date(serverNow).getTime();
}

export function remainingSeconds(deadlineIso: string, clientNowMs: number, skewMs: number): number {
  const deadline = new Date(deadlineIso).getTime();
  return Math.max(0, Math.round((deadline - (clientNowMs - skewMs)) / 1000));
}
