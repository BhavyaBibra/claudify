import os from "node:os";
import path from "node:path";

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Root of Claude Code's own data directory. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? expandHome(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

/** Where Claude Code stores per-project session transcripts. */
export function projectsDir(): string {
  return path.join(claudeHome(), "projects");
}

/**
 * Claudify's own state directory. Overridable via CLAUDIFY_HOME so tests can
 * run against a scratch directory without touching the real config.
 */
export function claudifyHome(): string {
  return process.env.CLAUDIFY_HOME
    ? expandHome(process.env.CLAUDIFY_HOME)
    : path.join(os.homedir(), ".claudify");
}

export function watchlistPath(): string {
  return path.join(claudifyHome(), "watchlist.json");
}

export function logPath(): string {
  return path.join(claudifyHome(), "claudify.log");
}

export function runsDir(): string {
  return path.join(claudifyHome(), "runs");
}

/** Where the installed `/away` command/skill lives inside Claude Code. */
export function claudeCommandsDir(): string {
  return path.join(claudeHome(), "commands");
}

/**
 * Claude Code encodes a project's absolute path into its transcript directory
 * name by replacing every character that isn't alphanumeric with `-`.
 * (e.g. `/Users/x/My.Proj` -> `-Users-x-My-Proj`.)
 *
 * This is only a best-effort helper for locating a directory; the authoritative
 * project path always comes from the `cwd` field inside the transcript records.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
