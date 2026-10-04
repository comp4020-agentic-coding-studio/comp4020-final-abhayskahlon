import { randomUUID } from "node:crypto";
import type { AstroCookies } from "astro";
import { createSession, findSession, touchSession } from "./db";
import type { Session } from "./schema";

// A lightweight, unauthenticated visitor identity: a random token set as an
// httpOnly cookie on first visit, matching the brief's "no authentication
// required" exactly (PROCESS.md, Decision 7). Two tabs in the same browser
// share this cookie and so share one session, on purpose; a different
// browser or an incognito window carries no cookie and gets its own.
const COOKIE_NAME = "commons_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // a year — this is an identity, not a flash message

// Small and deliberately not trying to be unique: two different visitors
// occasionally sharing a display label ("Calm Otter" twice) is a cosmetic
// coincidence, not a correctness problem — the session id underneath is
// what actually attributes an action, never the label.
const ADJECTIVES = ["Calm", "Quiet", "Bright", "Gentle", "Swift", "Curious", "Patient", "Kind", "Steady", "Cheerful"];
const ANIMALS = ["Otter", "Finch", "Fox", "Heron", "Hare", "Mole", "Wren", "Lynx", "Robin", "Badger"];

function randomLabel(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adjective} ${animal}`;
}

// Reads the session cookie, if any, and returns the session it names —
// creating a brand new one (and setting the cookie) when there isn't a
// valid one yet. Called on every page view and every action, so a visitor
// who's only ever looked still has a stable identity by the time they first
// act.
export function getOrCreateSession(cookies: AstroCookies): Session {
  const existingId = cookies.get(COOKIE_NAME)?.value;
  if (existingId) {
    const existing = findSession(existingId);
    if (existing) {
      touchSession(existingId);
      return existing;
    }
    // A cookie that doesn't match any row (e.g. the database was reset) is
    // never trusted as-is — fall through and mint a fresh one.
  }

  const session = createSession(randomUUID(), randomLabel());
  cookies.set(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return session;
}
