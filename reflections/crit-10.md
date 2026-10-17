# Crit 10 reflection

**What was the breakthrough that moved the work forward?**

The breakthrough wasn't a bug fix this week, it was catching a real design
conflict before writing any code. My own instructions for the room feature
described dedicated rooms, each with its own Milo — but that directly
contradicted two rules already fixed in this repo: CLAUDE.md's explicit
"out of scope: multiple creatures" and PROCESS.md's founding Decision 1,
"one persistent being, not one per user." The agent stopped at exactly
that point, laid out the conflict in plain terms, and asked me how I
wanted to resolve it rather than silently picking an interpretation or
silently overriding either rule. My answer — multiple people inside one
chat-room-like space, all sharing that room's own Milo — turned the pivot
into something to record deliberately (a new ADR, a new PROCESS.md
decision, an explicit note on what the old "no multiple creatures" rule
now means) instead of letting the code quietly drift away from its own
documented rules. That discipline — stop, name the conflict, get a
decision, then build — is what let a genuinely large change (new schema
table, every mutation re-scoped, SSE re-scoped, a new entry flow) land as
a sequence of small, reviewable, individually-tested commits rather than
one sprawling rewrite.

The other real piece of groundwork was realizing, from reading the actual
crit 10 spec text rather than just the brief, that server-side logging was
a flat zero in this codebase — not one `console.*` call anywhere in `src`.
The brief's room system is the student's own elaboration of "what counts
as a person"; the spec's requirement that the app "logs who did what,
server-side," outliving the crit, is fixed and non-negotiable, and it would
have been missed entirely by only building the room feature. Treating the
actual spec text as the ground truth, separate from the brief's framing,
is what surfaced that gap.

**What did this change about who I want to be as a software developer?**

This crit's lesson was about where authority to make a design decision
actually lives. A previous document in this repo (my own earlier
instructions) is not automatically the thing to follow when it conflicts
with a project's own already-approved, already-tested rules — the right
move was to treat that conflict as a question for me to answer, not
something to resolve by quietly privileging whichever instruction arrived
most recently. I want to keep building things so that a pivot like this is
always visible in the repo's own history — an ADR, a decision record,
an explicit "this used to mean X, now it means Y" note — rather than a
rule that silently stopped being true. The security design itself follows
the same instinct: the room a request acts on is derived from the trusted
session cookie, never from anything the client sends, specifically so
there's no route-by-route discipline to maintain and no single place a
future change could quietly reopen cross-room access. Closing a class of
mistake by construction, rather than by a check someone has to remember,
is the standard I want to keep holding implementation to, not just this
feature's access control.
