# COMMONS

One creature, Milo. Not one each — one, shared by everyone currently looking
at this page. A stranger who visits can feed, play with, walk, clean, or put
Milo to sleep, and the next stranger who visits sees exactly what that first
one left behind: Milo's current needs, and a short, chronological record of
who did what. There's no login — a lightweight, anonymous cookie is enough to
tell visitors apart — and most actions both help Milo and cost something
(cleaning is the one free action), so one person's choice changes what the
next person should reasonably do next.

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

Accounts, chat, leaderboards, achievements, shops, inventories, a second
creature, AI, notifications, maps, an admin dashboard. No score for being
the visitor who acted most — the history is unranked, on purpose.

## Tested vs. judged

Tested automatically, every time this ships: the four needs never leave
their 0–100 bound; an action the current state doesn't allow changes
nothing; care history is attributed to the session that actually acted, and
a rejected action is never recorded; two different visitors get distinct
identities; and a change one person makes reaches every other open tab
within about a second, via a signal that carries no copy of the state
itself — only SQLite does.

Left to a person, because no test can hold it: whether this actually reads
as shared responsibility rather than a solo pet with a visitor log attached,
whether the history feels informative rather than watched, and whether this
definition of good is itself any good. It's a first version, meant to
change as the week does.
