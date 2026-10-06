# Crit 8 reflection

**What was the breakthrough that moved the work forward?**

Early on I made my agent write a full design proposal before touching code,
and corrected it hard: no stored health field, exactly five actions with
real trade-offs, no neglect-callout feature yet, and an explicit decision
record for why one machine with one synchronous SQLite handle is enough
concurrency safety here — not a shortcut, a real architectural argument I
made it write down and that I checked made sense. That record-first habit
paid off directly: when a test later asserted two visitors' random display
labels must always differ, I could see from the record that labels were
never meant to be unique, so the test was wrong, not the app.

The bigger breakthrough was refusing to accept "it passed locally" as
evidence. I explicitly told the agent not to assume localhost SSE behaviour
proves anything in production, which is the only reason a real Fly
deployment got checked for latency, proxy buffering, autostop, and
reconnect before I'd call any of it done — and it also surfaced a genuine
test-isolation bug (two spec files racing against one shared app instance)
that would have stayed invisible otherwise.

**What did this change about who I want to be as a software developer?**

I want to be someone who treats a green test suite as a claim to interrogate,
not a finish line — and who directs an agent by insisting on verification
against the real thing, not the convenient one. No human has playtested
this yet; that's still ahead of me, not something to imply has already
happened.
