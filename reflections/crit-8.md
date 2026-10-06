# Crit 8 reflection

**What was the breakthrough that moved the work forward?**

The real breakthrough was refusing to let "every scripted test passes"
settle the question of whether the app actually worked. After a human
playtest kept showing a rejected action with a generic error message, dozens
of direct HTTP requests against the live production URL — matching
cookies, headers, even the real multipart body shape — returned a clean
success every single time. I told my agent not to conclude "cannot
reproduce" and not to keep guessing at UI fixes, and instead to add small,
clearly temporary diagnostic logging to the one path that mattered, deploy
it, and let me capture the evidence myself from an actual click in Chrome.
That one piece of real-browser evidence — a 404 against a URL ending in
"/[object HTMLInputElement]" — pointed straight at the cause: a hidden
form field literally named "action" was shadowing the form element's own
built-in `action` property, so the browser was posting to the wrong URL
entirely. No script had ever caught it, because every script we'd written
called fetch() with a URL string we typed ourselves — none of them ever
touched a real DOM form the way a browser does.

**What did this change about who I want to be as a software developer?**

I want to be someone who treats "I can't reproduce it" as an unfinished
investigation, not a conclusion — and who knows some bugs only exist in the
gap between what a test simulates and what a real browser does. Scripted
tests proved the server was right every time; only a human, clicking a
real button, could prove the client wasn't. The fix was one line. Finding
it required refusing to stop at the first plausible explanation, twice.
