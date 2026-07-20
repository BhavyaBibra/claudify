import { loadWatchlist, saveWatchlist, removeSession } from "../store/watchlist.js";
import type { WatchedSession } from "../store/schema.js";

function projName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function statusGlyph(s: WatchedSession): string {
  if (!s.enabled) return "off";
  return s.state.status;
}

export function runList(): void {
  const wl = loadWatchlist();
  if (wl.sessions.length === 0) {
    console.log("No sessions are being watched. Add one with `claudify watch`.");
    return;
  }
  const rows = wl.sessions.map((s) => ({
    project: projName(s.project),
    id: s.sessionId.slice(0, 8),
    status: statusGlyph(s),
    resets: s.state.resetAt ? new Date(s.state.resetAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) : "-",
    resumes: `${s.state.resumesThisCycle}/${s.grant.maxResumesPerLimitCycle}`,
    mode: s.grant.permissionMode,
    expires: new Date(s.grant.expiresAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }),
  }));
  printTable(rows, ["project", "id", "status", "resets", "resumes", "mode", "expires"]);
}

export function runOff(target: string | undefined, all: boolean): void {
  const wl = loadWatchlist();
  if (all) {
    for (const s of wl.sessions) s.enabled = false;
    saveWatchlist(wl);
    console.log(`Disabled auto-resume for all ${wl.sessions.length} session(s).`);
    return;
  }
  if (!target) throw new Error("Specify a session id (prefix) or --all.");
  const s = matchSession(wl.sessions, target);
  if (!s) throw new Error(`No watched session matching "${target}".`);
  s.enabled = false;
  saveWatchlist(wl);
  console.log(`Disabled auto-resume for ${projName(s.project)} (${s.sessionId.slice(0, 8)}).`);
}

export function runOn(target: string): void {
  const wl = loadWatchlist();
  const s = matchSession(wl.sessions, target);
  if (!s) throw new Error(`No watched session matching "${target}".`);
  if (Date.parse(s.grant.expiresAt) < Date.now()) {
    throw new Error("This session's grant has expired. Re-run `claudify watch` to grant again.");
  }
  s.enabled = true;
  if (s.state.status === "auth_needed" || s.state.status === "error" || s.state.status === "done" || s.state.status === "expired") {
    s.state.status = "watching";
    s.state.lastError = null;
  }
  saveWatchlist(wl);
  console.log(`Re-enabled auto-resume for ${projName(s.project)} (${s.sessionId.slice(0, 8)}).`);
}

export function runRemove(target: string): void {
  const wl = loadWatchlist();
  const s = findMatch(wl.sessions, target);
  if (!s) throw new Error(`No watched session matching "${target}".`);
  removeSession(wl, s.sessionId);
  saveWatchlist(wl);
  console.log(`Removed ${projName(s.project)} (${s.sessionId.slice(0, 8)}) from the watchlist.`);
}

function matchSession(sessions: WatchedSession[], target: string): WatchedSession | undefined {
  return findMatch(sessions, target);
}

function findMatch(sessions: WatchedSession[], target: string): WatchedSession | undefined {
  const exact = sessions.find((s) => s.sessionId === target);
  if (exact) return exact;
  const pref = sessions.filter((s) => s.sessionId.startsWith(target));
  return pref.length === 1 ? pref[0] : undefined;
}

function printTable(rows: Record<string, string>[], cols: string[]): void {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(line(cols.map((c) => c.toUpperCase())));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
}

// re-export for status reuse
export { findMatch };
