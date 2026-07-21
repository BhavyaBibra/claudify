/**
 * The Claude *desktop app* keeps its own per-session metadata store at
 *   ~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_*.json
 * The app's sidebar (title, recency order, turn count) comes from these files;
 * conversation *content* comes from the CLI transcript (keyed by `cliSessionId`).
 *
 * A headless `claude -p --resume` appends to the CLI transcript (so the content
 * shows in the GUI), but it does NOT touch these metadata files — so a resumed
 * conversation would not rise in the Recents list or show an updated turn count.
 * This module reads that store (to match the GUI's session list and titles) and
 * "touches" a session after a resume so it surfaces as freshly active.
 *
 * Everything here is best-effort and defensive: the store is undocumented and
 * may change between app versions, so failures are swallowed, never fatal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppStoreSession {
  file: string;
  sessionId: string; // the app's own id, e.g. local_xxxx
  cliSessionId: string; // maps to the CLI transcript uuid
  cwd: string;
  title: string;
  titleSource: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  isArchived: boolean;
  lastActivityAt: number;
  completedTurns?: number;
}

/** Root of the desktop app's session store (override via env for tests). */
export function appStoreRoot(): string {
  if (process.env.CLAUDIFY_APPSTORE_DIR) return process.env.CLAUDIFY_APPSTORE_DIR;
  const home = os.homedir();
  const leaf = ["Claude", "claude-code-sessions"];
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", ...leaf);
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), ...leaf);
    default: // linux / other
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), ...leaf);
  }
}

/** Whether the desktop app store is present on this machine. */
export function appStoreAvailable(): boolean {
  try {
    return fs.existsSync(appStoreRoot());
  } catch {
    return false;
  }
}

function walkJsonFiles(dir: string, depth = 3): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...walkJsonFiles(full, depth - 1));
    else if (e.isFile() && e.name.startsWith("local_") && e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function parseSession(file: string): AppStoreSession | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof d.cliSessionId !== "string") return null;
    return {
      file,
      sessionId: String(d.sessionId ?? ""),
      cliSessionId: d.cliSessionId,
      cwd: String(d.cwd ?? ""),
      title: String(d.title ?? ""),
      titleSource: String(d.titleSource ?? ""),
      permissionMode: typeof d.permissionMode === "string" ? d.permissionMode : undefined,
      model: typeof d.model === "string" ? d.model : undefined,
      effort: typeof d.effort === "string" ? d.effort : undefined,
      isArchived: Boolean(d.isArchived),
      lastActivityAt: Number(d.lastActivityAt ?? 0),
      completedTurns: typeof d.completedTurns === "number" ? d.completedTurns : undefined,
    };
  } catch {
    return null;
  }
}

/** All non-archived app-store sessions, newest activity first. */
export function listAppStoreSessions(): AppStoreSession[] {
  const files = walkJsonFiles(appStoreRoot());
  const sessions = files
    .map(parseSession)
    .filter((s): s is AppStoreSession => s !== null && !s.isArchived);
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return sessions;
}

/** Look up the app-store entry for a given CLI session id (or null). */
export function findByCliSessionId(cliSessionId: string): AppStoreSession | null {
  for (const file of walkJsonFiles(appStoreRoot())) {
    const s = parseSession(file);
    if (s && s.cliSessionId === cliSessionId) return s;
  }
  return null;
}

/**
 * Mark a session as freshly active in the desktop app's store, so a resumed
 * conversation rises to the top of the Recents list with a correct turn count.
 * Mutates only `lastActivityAt` (and `completedTurns` if provided); writes
 * atomically to avoid the running app reading a partial file. Best-effort.
 */
export function touchAppStoreSession(
  cliSessionId: string,
  opts: { addTurns?: number; at?: number } = {},
): boolean {
  try {
    const target = findByCliSessionId(cliSessionId);
    if (!target) return false;
    const raw = JSON.parse(fs.readFileSync(target.file, "utf8")) as Record<string, unknown>;
    raw.lastActivityAt = opts.at ?? Date.now();
    // Each resume submits one continuation prompt; reflect that as one more turn.
    const add = opts.addTurns ?? 1;
    if (typeof raw.completedTurns === "number") raw.completedTurns = raw.completedTurns + add;
    const tmp = target.file + `.claudify.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, target.file);
    return true;
  } catch {
    return false;
  }
}
