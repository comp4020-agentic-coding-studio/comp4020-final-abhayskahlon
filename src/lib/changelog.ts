// A tiny shared helper so the entry page's one-line "what's new" summary
// and the full /patch-notes/ detail page both read CHANGELOG.md's structure
// through exactly one place — never two independent parsers that could
// quietly drift apart on what "the latest patch" means.
import * as changelog from "../../CHANGELOG.md";

export interface LatestPatch {
  text: string; // e.g. "Patch 1.1 — Room milestones, a redesigned welcome, and patch notes"
  slug: string; // Astro's own heading slug — the same id /patch-notes/ renders for this heading
}

// The newest patch is CHANGELOG.md's first `##` heading — the file's own
// stated convention (see its own intro line: "newest first").
export function getLatestPatch(): LatestPatch | null {
  const heading = changelog.getHeadings().find((h) => h.depth === 2);
  return heading ? { text: heading.text, slug: heading.slug } : null;
}
