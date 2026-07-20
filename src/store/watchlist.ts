import fs from "node:fs";
import path from "node:path";
import { claudifyHome, watchlistPath } from "../util/paths.js";
import { Watchlist, emptyWatchlist, type WatchedSession } from "./schema.js";

/** Load and validate the watchlist, returning an empty one if none exists. */
export function loadWatchlist(): Watchlist {
  const p = watchlistPath();
  if (!fs.existsSync(p)) return emptyWatchlist();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`Watchlist at ${p} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = Watchlist.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Watchlist at ${p} failed validation:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

/** Atomically write the watchlist (temp file + rename). */
export function saveWatchlist(wl: Watchlist): void {
  const validated = Watchlist.parse(wl);
  fs.mkdirSync(claudifyHome(), { recursive: true });
  const p = watchlistPath();
  const tmp = path.join(path.dirname(p), `.watchlist.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2));
  fs.renameSync(tmp, p);
}

/** Read-modify-write helper with atomic persistence. */
export function updateWatchlist(fn: (wl: Watchlist) => void): Watchlist {
  const wl = loadWatchlist();
  fn(wl);
  saveWatchlist(wl);
  return wl;
}

export function findSession(wl: Watchlist, sessionId: string): WatchedSession | undefined {
  return wl.sessions.find((s) => s.sessionId === sessionId);
}

/** Add or replace a watched session by sessionId. */
export function upsertSession(wl: Watchlist, session: WatchedSession): void {
  const idx = wl.sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) wl.sessions[idx] = session;
  else wl.sessions.push(session);
}

export function removeSession(wl: Watchlist, sessionId: string): boolean {
  const before = wl.sessions.length;
  wl.sessions = wl.sessions.filter((s) => s.sessionId !== sessionId);
  return wl.sessions.length < before;
}
