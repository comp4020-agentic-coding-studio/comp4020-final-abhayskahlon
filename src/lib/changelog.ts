// A tiny shared helper so the entry page's "what's new" summary and the
// full /patch-notes/ detail page both read CHANGELOG.md's structure
// through exactly one place — never two independent parsers that could
// quietly drift apart on what "the latest patch" means.
import * as changelog from "../../CHANGELOG.md";

export interface LatestPatch {
  text: string; // e.g. "Patch 1.1 — Room milestones, a redesigned welcome, and patch notes"
  slug: string; // Astro's own heading slug — the same id /patch-notes/ renders for this heading
  // The real first body paragraph from CHANGELOG.md's own prose under that
  // heading — never invented, never a second hand-written copy of the
  // changelog's own words. Null only if that entry genuinely has no body
  // text yet (a heading with nothing under it).
  summary: string | null;
}

// The newest patch is CHANGELOG.md's first `##` heading — the file's own
// stated convention (see its own intro line: "newest first"). The summary
// is that heading's own first paragraph, taken from the RAW markdown
// source (not the compiled HTML) so this stays a plain string with no
// markup to strip — the same raw-text approach spec/patch-notes.test.ts
// already uses to read this same file.
export function getLatestPatch(): LatestPatch | null {
  const heading = changelog.getHeadings().find((h) => h.depth === 2);
  if (!heading) return null;

  const raw = changelog.rawContent();
  const afterHeading = raw.split(/^##\s+.+$/m).slice(1)[0] ?? "";
  const firstParagraph = afterHeading
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#"));
  // Collapse the source's own line-wrapping into plain spaces — this is
  // prose meant to read as one paragraph, not preformatted text.
  const summary = firstParagraph ? firstParagraph.replace(/\s+/g, " ") : null;

  return { text: heading.text, slug: heading.slug, summary };
}
