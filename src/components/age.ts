// Milo's age, formatted from the one stable timestamp src/lib/db.ts's
// getMiloAge() reuses (the earliest sessions.createdAt — see its comment
// for why that's an appropriate existing field rather than a new column).
// Pure and deterministic given `now`, so it's trivially testable.
export interface MiloAge {
  text: string;
  milestone: string | null;
}

// SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS", UTC, with no
// timezone marker. Without the explicit "Z" below, JS would parse that as
// LOCAL time instead of UTC, silently skewing the age by this server's own
// offset — every other place this app shows a timestamp just displays the
// raw string, but computing a duration means it has to be parsed correctly.
function parseSqliteTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export function formatMiloAge(createdAt: string | null, now: Date = new Date()): MiloAge {
  if (!createdAt) return { text: "brand new", milestone: null };

  const created = parseSqliteTimestamp(createdAt);
  const ms = Math.max(0, now.getTime() - created.getTime());
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const text = days >= 1 ? `${days} day${days === 1 ? "" : "s"} old` : hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"} old` : "just born";

  const milestone = days === 1 ? "first full day!" : days === 7 ? "one week old today!" : days === 30 ? "one month old today!" : null;

  return { text, milestone };
}
