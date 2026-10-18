# COMMONS

**Live:** https://comp4020-final-abhayskahlon.fly.dev/

One creature. Not one each — one, shared by everyone currently in the same
room. A room is an explicit, chosen scope: a visitor opens the site, enters
a name, and either hosts a brand-new room (getting a short code back) or
joins an existing one by typing that code. Everyone in the same room shares
that room's one creature — a stranger in there can feed, play with, walk,
clean, or put it to sleep, and the next person in that room sees exactly
what the one before them left behind: its current needs, and a short,
chronological record of who did what. A different room has its own
completely separate creature, history, and live updates — nothing one room
does is visible to another. There's no login — a lightweight, anonymous
cookie is enough to tell visitors in the same room apart — and most actions
both help the creature and cost something (cleaning is the one free
action), so one person's choice changes what the next person in that room
should reasonably do next.

The creature can look like one of five fixed, hand-drawn appearances —
Milo (the default), Plip, Bella, Simbaa, or Oliver — switched by any
visitor in the room. It's purely cosmetic: switching never resets or
changes stats, progress, or history, the same shared way a hat or scarf
already worked before appearances existed. Everyone in the room sees
whichever one is currently selected.

## Rooms

- **Host a room** from the entry screen with just a name; the server
  generates a short, unambiguous 6-character code (e.g. `4Q7K2P`) for that
  room and creates its own fresh Milo.
- **Join a room** with a name and an existing room's code — any number of
  visitors can join the same room and share its Milo.
- A room's host is shown ("Hosted by X") for attribution only — they have no
  extra powers over Milo compared to anyone else in the room.
- Joining or hosting always moves a visitor into that room, overwriting
  whichever room they were in before; `/?switch=1` reopens the entry screen
  to join or host a different one.
- The original pre-rooms Milo still exists, as a room with the fixed code
  `COMMONS` — nothing about its history or age was lost when rooms were
  introduced.

## Progression

Two separate, both unranked, both room-level — never a per-visitor score:

- **Milestones**: a lifetime count of every successful care action this
  room has ever taken, with a short flavor-text label at five points along
  the way (10, 50, 100, 250, 500). An open-ended "how much has this room
  done together, total."
- **Level**: a second, capped arc (levels 1 through 5) that unlocks a
  growing set of cosmetics as the room's shared total grows, ending in a
  golden crown at level 5. A closed-ended "how far along is this room,"
  distinct from the open-ended milestone count above.

Both move together — the same successful action feeds both — but neither
is derived from the other, and neither is ever attributed to which
visitor contributed what.

## What "good" means here (v1)

*A good shared-care system makes collective responsibility visible without
turning care into competition.*

That's a first, rough definition, guarding against two failures at once.
The first is invisibility: if nobody can see what anyone else did, shared
responsibility quietly becomes nobody's responsibility — the creature just
degrades, and no one in particular is accountable. The second is the
opposite overcorrection: make that visibility competitive — a leaderboard,
a score, "most caring visitor" — and the shared object stops being the
point; the ranking is. COMMONS sits between those: a visible, named,
chronological history of who acted, with no ranking attached at all.

## What grounds this

A few things we actually read while deciding this, not retrofitted after:

- Erickson & Kellogg, *"Social Translucence: An Approach to Designing
  Systems that Support Social Processes"* (ACM TOCHI, 2000) — the argument
  that visibility, awareness and accountability are what let people
  coordinate around something shared without needing an explicit authority.
  The "last action by X" line and the capped history are a small, direct
  attempt at exactly that: visible and attributable, nothing more.
- Dourish & Bellotti, *"Awareness and Coordination in Shared Workspaces"*
  (CSCW, 1992) — awareness gathered passively from the shared object itself,
  versus awareness that has to be explicitly broadcast (and so penalises
  whoever generates it). COMMONS has no "I did X!" announcement system; the
  history is a byproduct of acting, read passively by whoever looks.
- Latané, Williams & Harkins, *"Many Hands Make Light the Work"* (1979), on
  social loafing — shared effort, left unmeasured, tends to collapse toward
  nobody's effort. That collapse, not competition for its own sake, is the
  actual failure our definition is trying to name.
- Turkle's writing on "relational artifacts" (*Alone Together*) discusses
  the Tamagotchi-shaped genre we're deliberately not just cloning — a
  private, individual attachment to a small dependent creature. COMMONS asks
  what happens when that attachment has to be shared instead.

## What we chose not to build

Accounts, chat, leaderboards, shops, inventories, AI, notifications, maps,
an admin dashboard. No score for being the visitor who acted most — the
history is unranked, on purpose, and so are both of the room-level
progress tracks described above. Rooms let multiple *groups* each have
their own creature, isolated from every other group — not a second
creature within one room, not a per-user pet; the five selectable
appearances are five looks for that one creature, not five creatures.

## Tested vs. judged

Tested automatically, every time this ships: the four needs never leave
their 0–100 bound; an action the current state doesn't allow changes
nothing; care history is attributed to the session that actually acted, and
a rejected action is never recorded; two different visitors get distinct
identities; a change one person makes reaches every other open tab in the
same room within about a second, via a signal that carries no copy of the
state itself — only SQLite does; a room's creature, history, and live
updates are never visible to a different room; and every care action and
room event — success or rejection — is durably recorded server-side,
attributed to a non-reversible per-session tag, never the visitor's raw
session credential.

Left to a person, because no test can hold it: whether this actually reads
as shared responsibility rather than a solo pet with a visitor log attached,
whether the history feels informative rather than watched, and whether this
definition of good is itself any good. It's a first version, meant to
change as the week does.
