/**
 * Resolve the absolute path to the `claude` CLI. Critical for the launchd daemon,
 * whose PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`) and does NOT include
 * `~/.local/bin` where Claude Code installs itself — so a bare "claude" spawn
 * fails with ENOENT. We scan PATH, then well-known install locations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string | null = null;

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Absolute path to `claude`, or the bare name "claude" if nothing is found. */
export function claudeBin(): string {
  if (process.env.CLAUDIFY_CLAUDE_BIN) return process.env.CLAUDIFY_CLAUDE_BIN;
  if (cached) return cached;

  const home = os.homedir();
  const candidates: string[] = [];

  // 1. Whatever is on the current PATH (honors custom installs).
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "claude"));
  }
  // 2. Well-known Claude Code install locations (the launchd fallback path).
  candidates.push(
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".claude", "local", "claude"),
  );

  for (const c of candidates) {
    if (isExecutableFile(c)) {
      cached = c;
      return c;
    }
  }
  return "claude";
}

/** PATH string that includes claude's directory — baked into the launchd plist. */
export function augmentedPath(): string {
  const home = os.homedir();
  const extras = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".claude", "local"),
  ];
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const d of [...current, ...extras, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (!seen.has(d)) {
      seen.add(d);
      merged.push(d);
    }
  }
  return merged.join(path.delimiter);
}
