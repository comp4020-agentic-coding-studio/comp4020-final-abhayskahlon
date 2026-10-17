// Pure room logic: no database, no I/O — same "trivially unit testable,
// trivially safe to call with no await near it" shape as creature.ts (see
// PROCESS.md, Decision 4). src/lib/db.ts is the only thing that persists
// anything this computes or validates.

// Deliberately excludes visually ambiguous characters (0/O, 1/I/L) — a room
// code is meant to be read aloud or typed by a stranger from across a room,
// and a code that's ambiguous on a screen or when spoken defeats the whole
// point of a short code. 31 remaining characters, 6 of them: roughly 887
// million possible codes, so a random collision against any realistic
// number of concurrently-live rooms is vanishingly unlikely — src/lib/db.ts
// still retries on the rare collision rather than assuming it away.
export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

// Normalizes whatever a visitor typed (stray whitespace, lowercase) into
// the exact shape a stored room id can match — called before validation
// and before the lookup, never after, so "4q7k2p" and " 4Q7K2P " both find
// the same room " 4Q7K2P" was generated as.
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

// Checked AFTER normalizing, before ever querying the database with it:
// rejects obviously-malformed input (wrong length, outside the alphabet)
// with a clear reason, distinct from "no room with that code" — a 400
// "that doesn't look like a room code" versus a 404-shaped "no room found,"
// never conflated into one generic failure.
export function isValidRoomCodeFormat(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch));
}

export const DISPLAY_NAME_MAX_LENGTH = 40;

// A display label, not an identity — the actor id is always the session
// cookie, never this (same principle as src/lib/session.ts's randomly
// generated label: cosmetic, never what attribution actually relies on).
// Two visitors choosing the same name is explicitly fine, matching that
// existing precedent; this only rejects empty/whitespace-only input and an
// unreasonably long one.
export function isValidDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= DISPLAY_NAME_MAX_LENGTH;
}

export function normalizeDisplayName(name: string): string {
  return name.trim();
}
