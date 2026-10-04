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

    const resA = await post("/api/actions", a.cookie, new URLSearchParams({ action: "feed" }));
    expect(resA.status).toBe(303);
    const afterA = await loadHome();
    const labelA = lastActorLabel(afterA);
    expect(labelA).toBeTruthy();
    expect(mostRecentHistoryActor(afterA)).toBe(labelA);

    const resB = await post("/api/actions", b.cookie, new URLSearchParams({ action: "clean" }));
    expect(resB.status).toBe(303);
    const afterB = await loadHome();
    const labelB = lastActorLabel(afterB);
    expect(labelB).toBeTruthy();
    expect(labelB).not.toBe(labelA);
    expect(mostRecentHistoryActor(afterB)).toBe(labelB);
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
