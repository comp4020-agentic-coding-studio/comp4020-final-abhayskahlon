# Patch notes

What's changed, in plain terms, newest first — read live via `/patch-notes/`
and summarised on the entry page's own "what's new in COMMONS" section.

## Patch 1.7 — a quiet suggestion of what might help next

Right next to "Last action," the room view now shows at most one short,
friendly suggestion — "A Feed might help, fullness is getting low" — read
straight off the same four stats already shown as bars on the page. Never
a new mechanic: nothing is stored, nothing is broadcast, and it never
suggests an action the server would currently reject (too tired to play,
too hungry to sleep). Disappears once nothing really needs doing, and
never shows anything at all while the creature is asleep.

## Patch 1.6 — Milo redesigned as a proper puppy

The original character used to read as a generic rounded creature — his
ears were narrower than his own body and sat almost entirely hidden behind
it. He now has large floppy ears that clearly extend past the head on both
sides, a distinct cream muzzle, a small dark nose, warm brown eyes, and a
happy open smile with a little tongue. Same warm color palette and style
as the rest of COMMONS — just unmistakably a dog now. Purely a look.

## Patch 1.5 — Simbaa face proportions, corrected

A follow-up to the lamb redesign: her face was still reading as small and
dark next to her ears. The face is now noticeably larger and lighter, her
eyes are a warm brown instead of near-black and sized down a touch so
they're expressive without dominating the face, and the ears are about
30% smaller — still floppy and pink-lined, just no longer competing with
the face for attention. Still purely a look.

## Patch 1.4 — Simbaa actually looks like a lamb now

Simbaa's fleece used to be a smooth, rounded body with small circles dotted
around the outline — reading as decorations, not wool. The silhouette is
redrawn as genuine scalloped fleece (fluffy, rounded tufts, not spots),
with floppy ears and warm pink inner ears, a distinct face so the
expression doesn't get lost in the wool, a soft rounded nose, and visible
hooves. Purely a look — nothing about stats, levels, accessories, or care
history changed.

## Patch 1.3 — Five looks for Milo, and a shared level to work toward

The shared creature can now look like one of five appearances — Milo, Plip
the penguin, Bella the kitten, Simbaa the lamb, or Oliver the rabbit —
switched by anyone in the room. It's purely cosmetic: switching never
resets or changes stats, history, or progress, the same way wearing a hat
never did. Alongside the existing room milestone count, there's now a
second shared track: a level from 1 to 5, earned by real care, that
unlocks a growing set of hats, glasses, and scarves along the way,
ending in a golden crown at level 5. Both tracks are room-level and
unranked — nothing here is broken down by who did what, same as always.

## Patch 1.2 — A welcome page that actually looks like COMMONS

The entry page's background used to be an abstract shape that only claimed
to be Milo's silhouette — it wasn't. The real Milo now stands in a proper
welcome column alongside the room-entry panel, side by side on wider
screens and stacked in a sensible order on narrow ones. A returning
visitor's "continue to your room" card now shows that room's real,
current care total and milestone, not just a link back in. And "what's
new" is no longer a tiny footer line — it's a real section with a heading
and the latest patch's own summary, still linking through to the full
history here.

## Patch 1.1 — Room milestones, a redesigned welcome, and patch notes

Milo now tracks the total amount of care given in a room and marks
milestones along the way — a shared goal for the room, not a leaderboard:
nothing here is broken down by who did what, only how much the room has
done together. The entry/welcome page is centred, wider, and has a subtle
"live" background instead of sitting as a small card in the corner. And
this page: a changelog you can actually read, linked from the entry page.

## Patch 1.0 — Dedicated rooms

The biggest pivot this project has made: COMMONS moved from one shared
Milo for the entire deployment to dedicated rooms — a visitor now enters a
name and either hosts a brand-new room (getting a short code to share) or
joins an existing one by code. Everyone in the same room shares that
room's own Milo, fully isolated from every other room's. The original,
pre-rooms Milo survived the migration as its own room, under the fixed
code `COMMONS`. A server-side, non-reversible-actor-tagged event log was
added alongside this, recording every care action and room event — success
and rejection alike — durably, independent of how long the hosting
platform's own logs happen to be kept.
