# Crit 9 reflection

**What was the breakthrough that moved the work forward?**

This week's work was a full visual redesign — giving Milo an actual
character instead of a text badge, a real layout, icons, a palette. I had
the agent keep `pnpm check` at 19/19 the whole way through, but I'd told it
upfront that green checks weren't the bar: it had to actually look at the
rendered page, at more than one width, before either of us believed it was
done. When it did — real screenshots from a headless browser, desktop and
mobile — it found a defect no test could have caught: on the new
two-column desktop layout, the heading, intro text, and live indicator were
rendering *below* both content panels instead of above them. The cause was
a CSS Grid mistake — those three items had no explicit row, and by the time
the grid placed the panels that did, there was no room left in the rows
that show first, so they got pushed to a new row at the bottom. `pnpm check`
had no opinion on this at all, since nothing in it asserts where something
sits on screen; only the screenshot showed it. The fix was giving every
grid item an explicit row, then re-screenshotting to actually confirm it,
rather than trusting the CSS change alone.

**What did this change about who I want to be as a software developer?**

A passing test suite tells you the code does what you told it to check, not
that the result is actually right, and that gap is widest for anything
visual. Last week's lesson was that some bugs only exist in the space
between what a script simulates and what a real browser does; this week's
was the same lesson from a different angle — between what a build produces
and what a screen actually shows. I want to keep treating "all checks
green" as necessary and never sufficient, especially once anything touches
layout, and to keep insisting on an actual look at the rendered thing
before calling that part of the work finished. That standard stayed local
this week, deliberately: nothing here claims the production deployment was
touched or re-verified, only that the rendered result was actually checked
before being called correct.
