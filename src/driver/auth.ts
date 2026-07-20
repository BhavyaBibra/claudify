/**
 * Claude Code authentication helpers. Lets the dashboard offer a "Connect Claude
 * Code" button instead of making the user open a terminal. All auth knowledge
 * lives here (driver layer).
 */
import { execFile, spawn } from "node:child_process";
import { cleanEnv } from "./spawn.js";
import { claudeBin } from "./claudeBin.js";

function bin(): string {
  return claudeBin();
}

export interface AuthHint {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

/**
 * Cheap, quota-free signal from `claude auth status`. NOTE: this can report
 * loggedIn:true even when the token is expired (verified), so it is only a hint
 * for the UI — never the authoritative health check. Use testAuth() for truth.
 */
export function authHint(): Promise<AuthHint> {
  return new Promise((resolve) => {
    execFile(bin(), ["auth", "status"], { env: cleanEnv(), timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ loggedIn: false });
      try {
        const d = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
        resolve({ loggedIn: Boolean(d.loggedIn), email: d.email, subscriptionType: d.subscriptionType });
      } catch {
        resolve({ loggedIn: false });
      }
    });
  });
}

/**
 * Kick off the browser-based login (`claude auth login`). Detached so the daemon
 * / server doesn't block on it; the CLI opens the user's browser to approve.
 * Returns immediately — the user completes approval in the browser.
 */
export function startLogin(): { ok: boolean; error?: string } {
  try {
    const child = spawn(bin(), ["auth", "login", "--claudeai"], {
      env: cleanEnv(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * The authoritative auth check: one real 1-turn Haiku ping. Spends a tiny amount
 * of quota, so only call on demand (never on a poll).
 */
export function testAuth(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      bin(),
      ["-p", "--model", "claude-haiku-4-5", "--max-turns", "1", "--output-format", "json", "Reply with exactly: PONG"],
      { env: cleanEnv(), timeout: 60000 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, detail: err.message.slice(0, 140) });
        try {
          const d = JSON.parse(stdout) as { is_error?: boolean; api_error_status?: number; result?: string };
          if (d.is_error) return resolve({ ok: false, detail: `${d.api_error_status ?? ""} ${d.result ?? ""}`.trim() });
          resolve({ ok: true, detail: (d.result ?? "ok").slice(0, 40) });
        } catch {
          resolve({ ok: false, detail: "unparseable response from claude" });
        }
      },
    );
  });
}
