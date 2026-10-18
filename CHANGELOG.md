# Patch notes

What's changed, in plain terms, newest first — read live via `/patch-notes/`
and pointed to from the entry page's one-line "what's new" note.

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
