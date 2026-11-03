import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A STRUCTURAL/SOURCE regression test, not a visual or responsive-layout
// test — stated plainly, the same way spec/action-form-url.test.ts states
// jsdom's own limitation for the bug class it guards. jsdom has no real
// layout engine: it cannot compute actual element positions, so it cannot
// detect real overflow, clipping, or visual overlap at any viewport width.
// Those properties were instead checked by hand, against a real rendered
// browser at two real viewport widths — recorded separately in PROCESS.md's
// accessibility/progressive-enhancement audit, never claimed here. What
// this file CAN do, and does: read src/styles.css and src/pages/index.astro
// as plain text and assert the specific structural properties that already
// caused two real bugs in this project, found only by rendering:
//
// 1. Crit 9's bug (reflections/crit-9.md): a grid item with no explicit
//    `grid-row` silently fell below content that DID have one, because
//    auto-placement had no free cell left in the rows that render first.
//    The fix was giving every direct grid item its own explicit row — this
//    test asserts that fix holds, at both breakpoints that define it.
// 2. This session's own suggestion-wording bug: `.care-suggestion` must
//    stay a sibling of `.last-action`, never nested inside it, both
//    because sessions.test.ts/wardrobe.test.ts assert `.last-action`'s
//    exact textContent (PROCESS.md, Decision 17) and because nesting them
//    would make one visually read as part of the other's own sentence.
const CSS_PATH = "src/styles.css";
const ASTRO_PATH = "src/pages/index.astro";

// Returns the full text of a `@media (min-width: ...)` block, including
// its own nested rules, by balancing braces from the block's opening `{`
// — a plain non-greedy regex would stop at the FIRST `}`, which closes a
// rule inside the block, not the media query itself.
function extractMediaBlock(css: string, query: string): string {
  const start = css.indexOf(query);
  if (start === -1) throw new Error(`media query not found: ${query}`);
  const openBrace = css.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openBrace + 1, i);
    }
  }
  throw new Error(`unbalanced braces in media query: ${query}`);
}

// Returns the body of the first rule whose selector is EXACTLY `selector`
// (not a substring match — `.creature-panel` must not also match a rule
// for `.creature-panel-something`), within the given block of CSS text.
// Anchored to the start of a line (after indentation) rather than to a
// preceding `}`, since a rule can just as easily follow a comment's `*/`
// as another rule's closing brace.
function findRuleBody(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`, "m"));
  if (!match) throw new Error(`rule not found for selector "${selector}" in this media block`);
  return match[1];
}

describe("layout structure: the Decision-9 grid-row regression class", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("every direct grid item at the two-column (46rem) breakpoint has an explicit grid-row", () => {
    const block = extractMediaBlock(css, "@media (min-width: 46rem)");
    // Exactly the items crit 9 found silently dropping to the bottom: the
    // three full-width rows (h1/intro/live-indicator) PLUS the four panels
    // they'd otherwise collide with via auto-placement.
    const selectorsRequiringExplicitRow = [
      ".app-main > h1",
      ".app-main > .intro",
      ".app-main > .live-indicator",
      ".creature-panel",
      ".actions-panel",
      ".activities-panel",
      ".history-panel",
    ];
    for (const selector of selectorsRequiringExplicitRow) {
      const body = findRuleBody(block, selector);
      expect(body, `expected an explicit grid-row for "${selector}" at the 46rem breakpoint`).toMatch(/grid-row\s*:/);
    }
  });

  it("every panel redefined at the three-column (72rem) breakpoint keeps an explicit grid-row", () => {
    const block = extractMediaBlock(css, "@media (min-width: 72rem)");
    // Only the four panels are redefined at this width (h1/intro/live-
    // indicator keep the 46rem breakpoint's own row assignment, which the
    // test above already covers) — each one still needs its own explicit
    // row here, since this block also changes grid-template-columns,
    // which re-triggers the same auto-placement risk if any item here
    // were left without one.
    const selectorsRequiringExplicitRow = [".creature-panel", ".actions-panel", ".activities-panel", ".history-panel"];
    for (const selector of selectorsRequiringExplicitRow) {
      const body = findRuleBody(block, selector);
      expect(body, `expected an explicit grid-row for "${selector}" at the 72rem breakpoint`).toMatch(/grid-row\s*:/);
    }
  });
});

describe("layout structure: .care-suggestion stays a sibling of .last-action", () => {
  it("the suggestion paragraph never appears nested inside the last-action paragraph's own markup", () => {
    const source = readFileSync(ASTRO_PATH, "utf8");
    const openTag = '<p class="last-action">';
    const start = source.indexOf(openTag);
    expect(start, "expected to find the .last-action paragraph in index.astro").toBeGreaterThanOrEqual(0);

    // .last-action's own JSX body has no nested <p>, so its own closing
    // </p> is the very next one — if a future change nested
    // .care-suggestion inside it, this would need to become a real
    // balanced-tag scan instead of "find the next </p>"; stated here so a
    // later editor sees why, rather than silently trusting a naive find.
    const close = source.indexOf("</p>", start);
    expect(close, "expected a closing </p> for the .last-action paragraph").toBeGreaterThan(start);

    const lastActionBlock = source.slice(start, close);
    expect(lastActionBlock).not.toContain("care-suggestion");
  });
});
