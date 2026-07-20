/**
 * `claudify doctor` — preflight checks. The auth check spends a tiny amount of
 * quota (one Haiku turn) and only runs with --auth so `doctor` is otherwise free.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { projectsDir, watchlistPath } from "../util/paths.js";
import { loadWatchlist } from "../store/watchlist.js";
import { cleanEnv } from "../driver/spawn.js";
import { claudeBin } from "../driver/claudeBin.js";
import { isDarwin, agentInstalled } from "../platform/launchd.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(opts: { auth?: boolean } = {}): Promise<void> {
  const checks: Check[] = [];

  // 1. claude CLI on PATH + version.
  const bin = claudeBin();
  try {
    const ver = execFileSync(bin, ["--version"], { env: cleanEnv(), encoding: "utf8" }).trim();
    checks.push({ name: "claude CLI", ok: true, detail: ver });
  } catch {
    checks.push({ name: "claude CLI", ok: false, detail: `not found on PATH (looked for "${bin}")` });
  }

  // 2. projects dir readable.
  try {
    const n = fs.readdirSync(projectsDir()).length;
    checks.push({ name: "sessions dir", ok: true, detail: `${projectsDir()} (${n} projects)` });
  } catch {
    checks.push({ name: "sessions dir", ok: false, detail: `cannot read ${projectsDir()}` });
  }

  // 3. watchlist valid.
  try {
    const wl = loadWatchlist();
    checks.push({ name: "watchlist", ok: true, detail: `${wl.sessions.length} session(s) at ${watchlistPath()}` });
  } catch (err) {
    checks.push({ name: "watchlist", ok: false, detail: (err as Error).message });
  }

  // 4. platform / daemon agent.
  checks.push({
    name: "platform",
    ok: isDarwin(),
    detail: isDarwin() ? `macOS; daemon agent ${agentInstalled() ? "installed" : "not installed"}` : "non-macOS: daemon must be run manually (`claudify daemon run`)",
  });

  // 5. optional auth ping (spends a little quota).
  if (opts.auth) {
    try {
      const out = execFileSync(
        bin,
        ["-p", "--model", "claude-haiku-4-5", "--max-turns", "1", "--output-format", "json", "Reply with exactly: PONG"],
        { env: cleanEnv(), encoding: "utf8", timeout: 60000 },
      );
      const parsed = JSON.parse(out) as { is_error?: boolean; api_error_status?: number; result?: string };
      if (parsed.is_error) {
        checks.push({ name: "auth", ok: false, detail: `${parsed.api_error_status ?? ""} ${parsed.result ?? ""}`.trim() });
      } else {
        checks.push({ name: "auth", ok: true, detail: `ok (${(parsed.result ?? "").slice(0, 20)})` });
      }
    } catch (err) {
      checks.push({ name: "auth", ok: false, detail: (err as Error).message.slice(0, 120) });
    }
  } else {
    checks.push({ name: "auth", ok: true, detail: "skipped (run `claudify doctor --auth` to test login — spends a little quota)" });
  }

  console.log("Claudify doctor\n");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(13)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.some((c) => c.name === "auth")) {
    console.log("\nAuth is failing. Run `claude` in a terminal and complete /login, then retry.");
  }
  if (failed.length === 0) console.log("\nAll good.");
  process.exitCode = failed.length ? 1 : 0;
}
