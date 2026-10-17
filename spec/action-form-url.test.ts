import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";

// Regression coverage for a real, browser-only bug: every action form
// carries a hidden input literally named "action" (the field the server
// validates against — src/lib/creature.ts's ACTIONS, src/pages/api/
// actions.ts's form.get("action")). Per the HTML/DOM "named property"
// algorithm, a form control's `name` becomes a property on its form
// element, and in real browsers (confirmed via a live Chrome diagnostic:
// a POST that 404'd against the URL "…/[object%20HTMLInputElement]")
// that control SHADOWS HTMLFormElement's own built-in `action` property —
// `form.action` stops being the URL string and becomes the input element
// itself, so `fetch(form.action, …)` silently stringified it. No spec
// file here ever caught this, because none of them construct a real DOM
// form element; they only ever call fetch() with a hand-built URL string.
//
// Honest limitation: jsdom (this project's only DOM engine, per its
// established no-mocking-library convention) does NOT reproduce the
// shadowing itself — its HTMLFormElement implementation always returns
// the reflected URL from `.action` regardless of a same-named control, so
// this can't exercise the original failure directly. What it CAN prove,
// and what actually matters for correctness: the fixed code path
// (`form.getAttribute("action")`) resolves to the real route regardless
// of whatever a given DOM implementation does with the IDL property, and
// the source no longer contains the pattern that broke in production.
const baseUrl = inject("baseUrl");

// Since PROCESS.md, Decision 13: the five care-action forms only render
// once a session is inside a room — an anonymous GET / now shows the entry
// experience instead. Hosting a fresh room is the minimal way to reach the
// page these tests actually need to inspect.
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

async function loadRoomHome(): Promise<Document> {
  const visit = await fetch(new URL("/", baseUrl));
  const cookie = extractSessionCookie(visit);
  const hostRes = await post("/api/rooms/host", cookie, new URLSearchParams({ name: "Test Visitor" }));
  expect(hostRes.status, "expected hosting a room to succeed").toBe(303);
  const res = await fetch(new URL("/", baseUrl), { headers: { cookie } });
  return new JSDOM(await res.text()).window.document;
}

describe("action form URL resolution", () => {
  it("getAttribute(\"action\") resolves every action form to /api/actions", async () => {
    const doc = await loadRoomHome();
    const forms = [...doc.querySelectorAll<HTMLFormElement>(".action-form")];

    // One per action (feed/play/walk/clean/sleep) — all should resolve
    // identically, since they all share the same shape and the same
    // named "action" control that caused the shadowing.
    expect(forms.length).toBeGreaterThanOrEqual(5);
    for (const form of forms) {
      // The exact call src/pages/index.astro's submit handler makes.
      const actionUrl = form.getAttribute("action");
      expect(actionUrl).toBe("/api/actions");
    }
  });

  it("each action form still carries a control named \"action\" (the condition that caused the shadowing)", async () => {
    const doc = await loadRoomHome();
    const forms = [...doc.querySelectorAll<HTMLFormElement>(".action-form")];
    expect(forms.length).toBeGreaterThanOrEqual(5);
    for (const form of forms) {
      const namedInput = form.querySelector('input[name="action"]');
      expect(
        namedInput,
        "expected the hidden action input to still be named 'action' — if this ever changes, re-check whether form.getAttribute(\"action\") is still needed",
      ).not.toBeNull();
    }
  });

  it("the client script never reads the shadowable form.action property", () => {
    const source = readFileSync("src/pages/index.astro", "utf8");
    // The exact pattern that broke in production: fetch() given the DOM
    // property instead of the attribute. A regression back to this would
    // reintroduce the bug even though every HTTP-level spec test here
    // would keep passing, since none of them touch a real form element.
    expect(source).not.toMatch(/fetch\(\s*form\.action\b/);
    expect(source).toContain('form.getAttribute("action")');
  });
});
