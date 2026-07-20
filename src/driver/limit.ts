/**
 * Parsing of Claude Code's usage-limit messages and computation of the reset
 * instant. All knowledge of the limit-message wording lives here.
 *
 * Verified real samples (2026-07-14):
 *   "You've hit your session limit · resets 6pm (Asia/Calcutta)"
 *   "You've hit your session limit · resets 2:50am (Asia/Calcutta)"
 */

export interface ParsedLimit {
  /** e.g. "session", "weekly" — captured generically. */
  kind: string;
  /** Raw clock string, e.g. "6pm" or "2:50am". */
  timeStr: string;
  /** IANA timezone, e.g. "Asia/Calcutta". */
  tz: string;
}

const LIMIT_RE = /hit your (\w+) limit\s*[·:-]\s*resets\s+(.+?)\s*\(([^)]+)\)/i;

/** Returns parsed fields if `text` is a recognizable limit message, else null. */
export function parseLimitMessage(text: string): ParsedLimit | null {
  if (!text) return null;
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), timeStr: m[2].trim(), tz: m[3].trim() };
}

/** True if the text looks like any usage-limit message at all (loose check). */
export function looksLikeLimitMessage(text: string): boolean {
  return /hit your \w+ limit/i.test(text) || /usage limit/i.test(text);
}

interface Clock {
  hour: number; // 0-23
  minute: number;
}

/** Parse a 12-hour clock string like "6pm", "2:50am", "12am", "12pm". */
export function parseClock(timeStr: string): Clock | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i.exec(timeStr.trim());
  if (!m) {
    // Also accept a bare 24h "14:30".
    const m24 = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
    if (!m24) return null;
    const h = Number(m24[1]);
    const min = Number(m24[2]);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (mer === "am") {
    hour = hour === 12 ? 0 : hour;
  } else {
    hour = hour === 12 ? 12 : hour + 12;
  }
  return { hour, minute };
}

/**
 * The offset (ms) that must be *added* to a wall-clock-as-UTC instant to get the
 * true UTC instant for timezone `tz` at the given moment. Equivalently:
 *   trueUtc = Date.UTC(wallClockFields) - tzOffset(tz, nearThatInstant)
 * Implemented via Intl so no timezone database dependency is needed.
 */
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  // Round `date` to the second to match the formatted (second-resolution) value.
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return asUTC - actual;
}

/** Validate that an IANA timezone id is usable by Intl. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock Y/M/D currently showing in timezone `tz`. */
function localDateParts(tz: string, at: Date): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/**
 * Convert a wall-clock time (fields interpreted in `tz`) to a true UTC Date.
 * Uses one offset correction, which is exact except within the ~1h DST overlap
 * window (acceptable: a limit reset lands within a couple of minutes either way,
 * and we add a grace buffer downstream).
 */
function zonedToUtc(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

/**
 * Given a clock time and timezone, return the next instant at or after `now`
 * whose wall-clock in `tz` matches. Adds `graceMs` so we resume slightly after
 * the real reset rather than racing it.
 */
export function computeResetTime(
  timeStr: string,
  tz: string,
  now: Date = new Date(),
  graceMs = 2 * 60 * 1000,
): Date | null {
  if (!isValidTimeZone(tz)) return null;
  const clock = parseClock(timeStr);
  if (!clock) return null;

  const today = localDateParts(tz, now);
  const candidates: Date[] = [];
  for (let addDays = 0; addDays <= 1; addDays++) {
    // Advance the calendar day using a UTC anchor to avoid month/year rollover bugs.
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + addDays));
    candidates.push(
      zonedToUtc(
        tz,
        anchor.getUTCFullYear(),
        anchor.getUTCMonth() + 1,
        anchor.getUTCDate(),
        clock.hour,
        clock.minute,
      ),
    );
  }
  for (const c of candidates) {
    if (c.getTime() >= now.getTime()) {
      return new Date(c.getTime() + graceMs);
    }
  }
  // Both candidates are in the past (only possible in odd DST edges): push a day.
  return new Date(candidates[candidates.length - 1].getTime() + 24 * 60 * 60 * 1000 + graceMs);
}

/** Convenience: parse a full message and produce a reset Date in one step. */
export function resetTimeFromMessage(text: string, now: Date = new Date()): Date | null {
  const parsed = parseLimitMessage(text);
  if (!parsed) return null;
  return computeResetTime(parsed.timeStr, parsed.tz, now);
}
