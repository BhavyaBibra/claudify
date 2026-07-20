import { loadWatchlist } from "../store/watchlist.js";
import { agentInstalled } from "../platform/launchd.js";
import { logFileExists } from "../util/log.js";

function projName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function runStatus(): void {
  const wl = loadWatchlist();
  const enabled = wl.sessions.filter((s) => s.enabled);
  const waiting = enabled.filter((s) => s.state.status === "waiting_for_reset");
  const needAuth = wl.sessions.filter((s) => s.state.status === "auth_needed");

  console.log("Claudify status");
  console.log(`  daemon agent installed: ${agentInstalled() ? "yes" : "no"}`);
  console.log(`  notifications:          ${wl.settings.notifications ? "on" : "off"}`);
  console.log(`  poll interval:          ${wl.settings.pollIntervalSec}s`);
  console.log(`  watched sessions:       ${wl.sessions.length} (${enabled.length} enabled)`);
  console.log(`  waiting for reset:      ${waiting.length}`);
  console.log(`  log file:               ${logFileExists() ? "present" : "none yet"}`);

  if (needAuth.length) {
    console.log("\n⚠️  Auth needed — run `claude` in a terminal and /login, then `claudify on <id>`:");
    for (const s of needAuth) console.log(`     ${projName(s.project)} (${s.sessionId.slice(0, 8)})`);
  }

  if (waiting.length) {
    console.log("\nUpcoming resumes:");
    for (const s of waiting.sort((a, b) => (a.state.resetAt ?? "").localeCompare(b.state.resetAt ?? ""))) {
      const when = s.state.resetAt ? new Date(s.state.resetAt).toLocaleString() : "?";
      console.log(`  ${when}  ${projName(s.project)} (${s.sessionId.slice(0, 8)})`);
    }
  }
}
