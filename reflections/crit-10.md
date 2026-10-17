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

A deliberate ship-readiness review, done before pushing anything (the repo
auto-deploys on push, so push and ship are the same action here), caught
three real problems none of the automated tests had: the migration's
backfill would have shown a stranger — "Curious Hare," whoever happened to
act last before migration — as having *hosted* the pre-existing room they
never created; Milo's displayed age would have silently reset from its
real history to "new," because the backfill read the wrong timestamp
column; and the legacy room's own fixed id, `"COMMONS"`, would have failed
the room-code format check, so nobody could ever have joined it by typing
its own code. All three were found by actually simulating the migration
against a production-shaped database rather than just reading the SQL, and
the third specifically only surfaced once a regression test exercised the
real join route instead of checking the database directly — a reminder
that "I read the code and it looks right" and "I ran the actual path" are
not the same evidence, which is exactly this project's PROCESS.md pattern
from Incidents 1–3, now showing up again at a different layer (migration
correctness instead of client-server behaviour).

The same review also found that the new logging feature itself leaked a
real credential: each log line carried the raw session id, which IS the
visitor's entire bearer credential (there's no password — PROCESS.md,
Decision 7). Anyone who could read the logs could have lifted a session id
and impersonated that visitor. And "logs outlive the crit" turned out to
be an assumption, not a checked fact — Fly's own documentation states
roughly 7 days of retention for the feature that figure actually describes,
but that feature couldn't be directly exercised and confirmed for this
specific account from this review, and the plain `flyctl logs` command
this project's own instructions point to returns only a short in-memory
buffer, nowhere close to a week. Both are now stated plainly as limitations
rather than quietly assumed away.

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

Stated honestly, not resolved: stdout logging alone is not a durable
enough record for anything past the crit week itself, given what's
actually confirmed about Fly's retention versus what the assessment
timeline needs. The identified next step — a small, bounded `log_events`
table recording the same events durably — has since been built, with
authorisation, once the retention gap was actually named as a real
problem rather than left as a vague "worth considering later."

**Building that table surfaced its own lesson, about testing migrations
honestly.** The regression test for the rooms migration
(`spec/room-migration-backfill.test.ts`) filtered which real migration
files counted as "before rooms" by checking their file NAME — which
happened to work, right up until a migration was added after rooms, at
which point the filter silently included it in the wrong group. The
actual effect was serious: drizzle's migrator tracks "already applied"
against a single timestamp watermark, not which specific files ran, so
including a later-dated migration in the "before rooms" simulation pushed
that watermark forward and made the real migrator skip the ROOMS
migration entirely on the next pass — the `rooms` table would never have
been created, in a scenario this project's own test suite was supposed to
be guarding against. This was caught only because the test actually ran
the full real migration set afterward and asserted on what came out, not
because anyone re-read the migration SQL and reasoned it through — the
same "run the actual path, don't just read the code" standard this
project's earlier incidents already established, showing up again at a
layer (migration test infrastructure) that hadn't been exercised that way
before. Fixed by filtering on timestamp position relative to the rooms
migration instead of on the migration's name.

The table itself was built to the standard the rest of this project holds
rejection-handling to: a rejected action's log row has to survive even
though its own mutation's transaction rolled back (solved by writing it
as a plain statement after that transaction has already settled, never
nested inside it), and a failure to write the log itself must never be
allowed to change what the real action actually did (solved by catching
that failure explicitly and proving it with a test that drops the real
table out from under a running server mid-request, rather than just
trusting a try/catch exists). Both of those are properties a casual
reading of "add a table and write to it" would not have forced — they
only showed up by asking "what happens when this specific thing fails,"
the same question this project's whole incident log keeps coming back to.
