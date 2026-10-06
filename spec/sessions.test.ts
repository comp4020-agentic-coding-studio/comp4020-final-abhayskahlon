import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";

// Turns this milestone's spec lines into checks: separate visitors get
// distinct session identities, a successful action is attributed to the
// session that actually performed it, and a rejected action never touches
// the care history or the recorded last actor. Runs against the shared
// running app (spec/global-setup.ts) — spec/persistence.test.ts covers
// surviving an actual process restart, which needs its own instance.
const baseUrl = inject("baseUrl");

// Astro checks form POSTs carry a same-origin Origin header; browsers send
// it automatically, a bare fetch doesn't.
function post(path: string, cookie: string, body: URLSearchParams): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, cookie },
    body,
    redirect: "manual",
  });
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/commons_session=([^;]+)/);
  if (!match) throw new Error(`no commons_session cookie on the response (set-cookie: ${setCookie})`);
  return `commons_session=${match[1]}`;
}

// A "fresh visitor": no cookie sent, so the server has to mint one. Every
// call gets its own — never reuses another test's.
async function newVisitor(): Promise<{ cookie: string }> {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  return { cookie: extractSessionCookie(res) };
}

async function loadHome(cookie?: string): Promise<Document> {
  const res = await fetch(new URL("/", baseUrl), cookie ? { headers: { cookie } } : undefined);
  return new JSDOM(await res.text()).window.document;
}

function lastActorLabel(doc: Document): string | null {
  const strongs = [...doc.querySelectorAll(".last-action strong")];
  return strongs.length >= 2 ? (strongs[1].textContent ?? null) : null;
}

function mostRecentHistoryActor(doc: Document): string | null {
  return doc.querySelector(".history-list li strong")?.textContent ?? null;
}

describe("session identity", () => {
  it("gives two fresh visitors distinct session cookies", async () => {
    const a = await newVisitor();
    const b = await newVisitor();
    expect(a.cookie).not.toBe(b.cookie);
  });

  it("recognises a returning visitor instead of minting a new session", async () => {
    const a = await newVisitor();
    const again = await fetch(new URL("/", baseUrl), { headers: { cookie: a.cookie } });
    // No Set-Cookie on a request that already carried a valid session —
    // the server recognised it rather than replacing it.
    expect(again.headers.get("set-cookie")).toBeNull();
  });
});

describe("care history attribution", () => {
  it("attributes a successful action to the session that performed it", async () => {
    const a = await newVisitor();
    const b = await newVisitor();
    expect(a.cookie).not.toBe(b.cookie); // genuinely distinct sessions

    const resA = await post("/api/actions", a.cookie, new URLSearchParams({ action: "feed" }));
    expect(resA.status).toBe(303);
    const afterA = await loadHome();
    const labelA = lastActorLabel(afterA);
    expect(labelA).toBeTruthy();
    expect(mostRecentHistoryActor(afterA)).toBe(labelA);
    expect(afterA.querySelector(".last-action")?.textContent).toContain("Feed");

    const resB = await post("/api/actions", b.cookie, new URLSearchParams({ action: "clean" }));
    expect(resB.status).toBe(303);
    const afterB = await loadHome();
    const labelB = lastActorLabel(afterB);
    expect(labelB).toBeTruthy();
    expect(mostRecentHistoryActor(afterB)).toBe(labelB);
    // Session LABELS are cosmetic and may occasionally coincide by design
    // (src/lib/session.ts — the id is what actually attributes an action,
    // never the label), so this doesn't assert labelA !== labelB. What it
    // does assert: the recorded last action flips to B's action type after
    // B acts, proving the second action's attribution genuinely overwrote
    // the first's record rather than being stale, duplicated, or ignored.
    expect(afterB.querySelector(".last-action")?.textContent).toContain("Clean");
    expect(afterB.querySelector(".last-action")?.textContent).not.toContain("Feed");
  });
});

// Regression coverage for a bug report: the "Recent care" panel stayed
// stale after a successful action even though the backend had genuinely
// recorded it. Root cause was client-side (src/pages/index.astro) — the
// old success handler trusted `fetch()`'s automatic 303-follow and read a
// non-OK followed response's body straight into the visible error box,
// which both skipped the refresh AND risked injecting an HTML document as
// if it were a plain-text reason. These tests cover the HTTP-level
// contract that fix relies on: the one thing a browser can't be run here
// to check directly is the client script itself, so this proves the
// *server* always gives it what it needs to get this right.
describe("live-state refresh contract", () => {
  it("a successful action's new care event appears in the same rendered state as the updated stats", async () => {
    const a = await newVisitor();
    const before = await loadHome();
    const statsBefore = [...before.querySelectorAll(".stat-value")].map((el) => el.textContent);

    const res = await post("/api/actions", a.cookie, new URLSearchParams({ action: "clean" }));
    expect(res.status).toBe(303);

    // This is exactly what the client's refreshLiveState() fetches: one
    // GET /, expected to carry the new history entry AND the changed
    // stats together, never one without the other.
    const after = await loadHome();
    const statsAfter = [...after.querySelectorAll(".stat-value")].map((el) => el.textContent);
    expect(statsAfter, "cleanliness should now read 100").not.toEqual(statsBefore);
    expect(mostRecentHistoryActor(after)).toBe(lastActorLabel(after));
    expect(after.querySelector(".history-list")?.textContent).toContain("cleaned Milo");
  });

  it("never serves an HTML document from a rejected action — the client's content-type guard relies on this", async () => {
    const a = await newVisitor();

    // An action name the server itself rejects outright.
    const unknown = await post("/api/actions", a.cookie, new URLSearchParams({ action: "fly" }));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("content-type") ?? "").not.toContain("html");

    // A valid action name the current state rejects.
    let rejected: Response | undefined;
    for (let i = 0; i < 20 && !rejected; i++) {
      const res = await post("/api/actions", a.cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) rejected = res;
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBeDefined();
    expect(rejected?.headers.get("content-type") ?? "").not.toContain("html");
  });
});

describe("rejected actions", () => {
  it("never add a care_events row or change the recorded last action", async () => {
    const a = await newVisitor();

    // Drain energy via `play` until the server itself rejects one —
    // deterministic regardless of what energy happens to be from earlier
    // tests, since a rejection never changes state (so once rejected, it
    // stays rejected for every further `play` call).
    let rejected: Response | undefined;
    for (let i = 0; i < 20 && !rejected; i++) {
      const res = await post("/api/actions", a.cookie, new URLSearchParams({ action: "play" }));
      if (res.status === 409) rejected = res;
    }
    expect(rejected, "expected play to eventually be rejected once energy ran out").toBeDefined();

    const before = await loadHome();
    const historyBefore = [...before.querySelectorAll(".history-list li")].map((li) => li.textContent);
    const lastActionBefore = before.querySelector(".last-action")?.textContent ?? null;

    const res = await post("/api/actions", a.cookie, new URLSearchParams({ action: "play" }));
    expect(res.status).toBe(409);

    const after = await loadHome();
    const historyAfter = [...after.querySelectorAll(".history-list li")].map((li) => li.textContent);
    const lastActionAfter = after.querySelector(".last-action")?.textContent ?? null;

    expect(historyAfter).toEqual(historyBefore);
    expect(lastActionAfter).toBe(lastActionBefore);
  });
});
