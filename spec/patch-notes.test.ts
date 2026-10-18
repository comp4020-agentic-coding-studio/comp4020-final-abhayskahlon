import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";

// Covers the entry page's one-line "what's new" pointer (src/lib/
// changelog.ts) and the full /patch-notes/ detail page (src/pages/
// patch-notes.astro) — CHANGELOG.md rendered the same way README.md
// already is via readme.astro, confirmed working for this exact shape of
// content there. spec/invariants.test.ts (never edited — CLAUDE.md) proves
// README.md's own heading-matching contract; this file proves the
// equivalent contract for CHANGELOG.md with its own, separate helpers,
// since that file can't be imported from or extended.
//
// Shared instance (spec/global-setup.ts): everything here is read-only —
// no session, no room, no mutation — so there's nothing for a concurrent
// spec file's own state to interfere with, the same reasoning
// spec/invariants.test.ts's own shared-instance use already rests on.
const baseUrl = inject("baseUrl");

const text = (html: string): string => new JSDOM(html).window.document.body.textContent ?? "";

const normalise = (s: string): string =>
  s
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

function headings(md: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^ {0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/);
    if (heading) found.push(heading[1]);
  }
  return found;
}

describe("patch notes", () => {
  it("publishes CHANGELOG.md at /patch-notes/, every heading present and in order", async () => {
    const expected = headings(readFileSync("CHANGELOG.md", "utf8"));
    expect(expected, "CHANGELOG.md has no headings to check /patch-notes/ against").not.toEqual([]);

    const res = await fetch(new URL("/patch-notes/", baseUrl));
    expect(res.status).toBe(200);
    const served = normalise(text(await res.text()));

    let from = 0;
    for (const heading of expected) {
      const at = served.indexOf(normalise(heading), from);
      expect(at, `/patch-notes/ is missing the CHANGELOG.md heading "${heading}" (or has it out of order)`).not.toBe(-1);
      from = at + normalise(heading).length;
    }
  });

  it("the entry page's summary link text matches CHANGELOG.md's newest (first ##) heading exactly", async () => {
    const md = readFileSync("CHANGELOG.md", "utf8");
    // The first level-2 heading only — CHANGELOG.md's own stated
    // convention is "newest first" (see its own intro line).
    const h2Match = md.match(/^##\s+(.+?)\s*$/m);
    expect(h2Match, "expected at least one ## heading in CHANGELOG.md").not.toBeNull();
    const newest = h2Match![1];

    const res = await fetch(new URL("/", baseUrl));
    const doc = new JSDOM(await res.text()).window.document;
    const link = doc.querySelector(".entry-patch-note a");
    expect(link, "expected a patch-note summary link on the entry page").not.toBeNull();
    expect(link?.textContent?.trim()).toBe(newest);
  });

  it("the entry page's summary link points at an anchor that actually exists on /patch-notes/", async () => {
    const homeRes = await fetch(new URL("/", baseUrl));
    const homeDoc = new JSDOM(await homeRes.text()).window.document;
    const href = homeDoc.querySelector(".entry-patch-note a")?.getAttribute("href");
    expect(href, "expected the summary link to have an href").toBeTruthy();

    const [path, fragment] = (href as string).split("#");
    expect(path).toBe("/patch-notes/");
    expect(fragment, "expected the link to target a specific heading's anchor, not just the page top").toBeTruthy();

    const patchNotesRes = await fetch(new URL(path, baseUrl));
    const patchNotesDoc = new JSDOM(await patchNotesRes.text()).window.document;
    expect(
      patchNotesDoc.getElementById(fragment as string),
      `expected an element with id="${fragment}" on /patch-notes/`,
    ).not.toBeNull();
  });

  it("the site header links to /patch-notes/ from both the entry page and /readme/", async () => {
    const homeRes = await fetch(new URL("/", baseUrl));
    const homeDoc = new JSDOM(await homeRes.text()).window.document;
    expect(homeDoc.querySelector('.site-header a[href="/patch-notes/"]')).not.toBeNull();

    const readmeRes = await fetch(new URL("/readme/", baseUrl));
    const readmeDoc = new JSDOM(await readmeRes.text()).window.document;
    expect(readmeDoc.querySelector('.site-header a[href="/patch-notes/"]')).not.toBeNull();
  });
});
