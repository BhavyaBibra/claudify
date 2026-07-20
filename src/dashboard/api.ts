/**
 * Backend for the local dashboard. Pure functions over the store + transcript
 * reader; the HTTP layer (server.ts) just maps requests onto these. No Claude
 * knowledge here beyond what the driver already exposes.
 */
import path from "node:path";
import { listSessions } from "../driver/transcript.js";
import { listAppStoreSessions, appStoreAvailable, findByCliSessionId, touchAppStoreSession } from "../driver/appstore.js";
import { runResume } from "../driver/spawn.js";
import { saveRun } from "../daemon/runstore.js";
import { projectsDir, encodeProjectDir } from "../util/paths.js";
import {
  loadWatchlist,
  saveWatchlist,
  upsertSession,
  removeSession,
  findSession,
} from "../store/watchlist.js";
import {
  DEFAULT_CONTINUATION_PROMPT,
  composeContinuationPrompt,
  PermissionMode,
  type Grant,
  type WatchedSession,
} from "../store/schema.js";
import { parseDuration } from "../cli/watch.js";

export interface StateResponse {
  now: string;
  settings: { notifications: boolean; maxConcurrentResumes: number; pollIntervalSec: number };
  watched: WatchedView[];
  available: AvailableView[];
}

interface WatchedView {
  sessionId: string;
  shortId: string;
  title: string;
  project: string;
  projectName: string;
  enabled: boolean;
  trigger: string;
  scheduledAt: string | null;
  goal: string;
  status: string;
  resetAt: string | null;
  resumesThisCycle: number;
  maxResumes: number;
  maxSpendUsd: number;
  spentUsd: number;
  permissionMode: string;
  allowedTools: string[];
  expiresAt: string;
  continuationPrompt: string;
  lastError: string | null;
  lastRun: WatchedSession["state"]["lastRun"];
}

interface AvailableView {
  sessionId: string;
  shortId: string;
  title: string;
  project: string;
  projectName: string;
  summary: string;
  lastActivity: string;
}

function projectName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** How many recent sessions to offer in "Add a session" (matches the app's list). */
const AVAILABLE_LIMIT = 15;

export function getState(): StateResponse {
  const wl = loadWatchlist();
  const watchedIds = new Set(wl.sessions.map((s) => s.sessionId));

  // Titles come from the desktop app's own store so the dashboard matches the
  // GUI sidebar exactly (title keyed by cliSessionId == our sessionId).
  const appTitles = new Map<string, string>();
  const useAppStore = appStoreAvailable();
  if (useAppStore) {
    for (const s of listAppStoreSessions()) {
      if (s.cliSessionId) appTitles.set(s.cliSessionId, s.title || s.cliSessionId.slice(0, 8));
    }
  }

  const watched: WatchedView[] = wl.sessions.map((s) => ({
    sessionId: s.sessionId,
    shortId: s.sessionId.slice(0, 8),
    title: appTitles.get(s.sessionId) ?? projectName(s.project),
    project: s.project,
    projectName: projectName(s.project),
    enabled: s.enabled,
    trigger: s.trigger,
    scheduledAt: s.scheduledAt,
    goal: s.goal,
    status: s.enabled ? s.state.status : "off",
    resetAt: s.state.resetAt,
    resumesThisCycle: s.state.resumesThisCycle,
    maxResumes: s.grant.maxResumesPerLimitCycle,
    maxSpendUsd: s.grant.maxSpendUsd,
    spentUsd: s.state.spentThisGrantUsd,
    permissionMode: s.grant.permissionMode,
    allowedTools: s.grant.allowedTools,
    expiresAt: s.grant.expiresAt,
    continuationPrompt: s.continuationPrompt,
    lastError: s.state.lastError,
    lastRun: s.state.lastRun,
  }));

  // The "Add a session" list mirrors the Claude app's sidebar: read it straight
  // from the desktop app's session store (title + recency + cliSessionId). This
  // is the same set of conversations the user sees in the GUI, no CLI-transcript
  // noise. Falls back to the raw transcript folder when the app store is absent
  // (non-macOS, or the desktop app was never used).
  let available: AvailableView[];
  if (useAppStore) {
    available = listAppStoreSessions()
      .filter((s) => s.cliSessionId && !watchedIds.has(s.cliSessionId))
      .slice(0, AVAILABLE_LIMIT)
      .map((s) => ({
        sessionId: s.cliSessionId,
        shortId: s.cliSessionId.slice(0, 8),
        title: s.title || s.cliSessionId.slice(0, 8),
        project: s.cwd,
        projectName: projectName(s.cwd),
        summary: s.title,
        lastActivity: new Date(s.lastActivityAt).toISOString(),
      }));
  } else {
    available = listSessions()
      .filter((s) => !watchedIds.has(s.sessionId))
      .slice(0, AVAILABLE_LIMIT)
      .map((s) => ({
        sessionId: s.sessionId,
        shortId: s.sessionId.slice(0, 8),
        title: s.title,
        project: s.project,
        projectName: projectName(s.project),
        summary: s.summary,
        lastActivity: s.lastActivity,
      }));
  }

  return {
    now: new Date().toISOString(),
    settings: wl.settings,
    watched,
    available,
  };
}

export interface ArmBody {
  sessionId: string;
  mode?: string;
  allow?: string[] | string;
  model?: string;
  maxTurns?: number;
  maxResumes?: number;
  expiresIn?: string;
  prompt?: string;
  priority?: number;
  acceptFullAutonomy?: boolean;
  /** USD spend cap for the whole grant; 0/blank = no cap. */
  maxSpendUsd?: number;
  /** "limit" (default) or "scheduled". */
  trigger?: string;
  /** For trigger="scheduled": when to fire. Accepts an ISO string or a
   *  datetime-local value ("2026-07-17T15:30"). */
  scheduledAt?: string;
}

/** Arm (or re-arm) a session with a grant. Returns an error message or null. */
export function armSession(body: ArmBody): { ok: boolean; error?: string } {
  // Resolve the session's project + transcript. Prefer the CLI transcript folder;
  // fall back to the desktop app store (for GUI sessions listed from there).
  let project: string;
  let transcriptPath: string;
  const info = listSessions().find((s) => s.sessionId === body.sessionId);
  if (info) {
    project = info.project;
    transcriptPath = info.transcriptPath;
  } else {
    const app = findByCliSessionId(body.sessionId);
    if (!app) return { ok: false, error: `Session ${body.sessionId} not found.` };
    project = app.cwd;
    transcriptPath = path.join(projectsDir(), encodeProjectDir(app.cwd), `${body.sessionId}.jsonl`);
  }

  const modeParse = PermissionMode.safeParse(body.mode ?? "acceptEdits");
  if (!modeParse.success) {
    return { ok: false, error: `Invalid permission mode "${body.mode}".` };
  }
  if (modeParse.data === "bypassPermissions" && !body.acceptFullAutonomy) {
    return { ok: false, error: "bypassPermissions requires explicit full-autonomy confirmation." };
  }

  const durMs = parseDuration(body.expiresIn ?? "12h");
  if (durMs == null) return { ok: false, error: `Invalid expiry "${body.expiresIn}".` };

  const allow = Array.isArray(body.allow)
    ? body.allow
    : (body.allow ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const grant: Grant = {
    permissionMode: modeParse.data,
    allowedTools: allow,
    model: body.model && body.model.trim() ? body.model.trim() : "inherit",
    maxTurnsPerResume: clampInt(body.maxTurns, 50, 1, 1000),
    maxResumesPerLimitCycle: clampInt(body.maxResumes, 3, 1, 100),
    maxSpendUsd: typeof body.maxSpendUsd === "number" && Number.isFinite(body.maxSpendUsd) && body.maxSpendUsd > 0
      ? Math.min(body.maxSpendUsd, 10000)
      : 0,
    expiresAt: new Date(Date.now() + durMs).toISOString(),
    consentedAt: new Date().toISOString(),
  };

  // Trigger: wait for a real limit (default) or fire at a set time.
  const trigger = body.trigger === "scheduled" ? "scheduled" : "limit";
  let scheduledAt: string | null = null;
  if (trigger === "scheduled") {
    const parsed = parseWhen(body.scheduledAt);
    if (!parsed) {
      return { ok: false, error: "Pick a valid date & time for the scheduled resume." };
    }
    if (parsed.getTime() > Date.now() + durMs) {
      return { ok: false, error: "That time is after this session turns itself off — increase 'Turn off after'." };
    }
    scheduledAt = parsed.toISOString();
  }

  const existing = findSession(loadWatchlist(), body.sessionId);
  const watched: WatchedSession = {
    sessionId: body.sessionId,
    project,
    transcriptPath,
    enabled: true,
    priority: clampInt(body.priority, existing?.priority ?? 1, -1000, 1000),
    // The user's text is an OBJECTIVE, wrapped into a self-aware prompt so it
    // won't be blindly re-issued on later resumes. Blank -> "just continue".
    goal: body.prompt?.trim() ?? existing?.goal ?? "",
    continuationPrompt: body.prompt?.trim()
      ? composeContinuationPrompt(body.prompt.trim())
      : (existing?.continuationPrompt || DEFAULT_CONTINUATION_PROMPT),
    trigger,
    scheduledAt,
    grant,
    state: existing?.state ?? {
      status: "watching",
      limitHitAt: null,
      resetAt: null,
      resumesThisCycle: 0,
      relimitStreak: 0,
      spentThisGrantUsd: 0,
      lastRun: null,
      lastError: null,
    },
  };
  // A (re)arm is a fresh grant, so it starts a fresh spend budget and cycle.
  watched.state.spentThisGrantUsd = 0;
  watched.state.resumesThisCycle = 0;
  watched.state.relimitStreak = 0;
  // Re-arming clears a stuck terminal state so it starts watching again.
  if (["auth_needed", "error", "done", "expired"].includes(watched.state.status)) {
    watched.state.status = "watching";
    watched.state.lastError = null;
  }
  // A scheduled session goes straight to "waiting" with its fire time — the
  // scheduler's existing due-time logic then resumes it, no limit event needed.
  if (trigger === "scheduled" && scheduledAt) {
    watched.state.status = "waiting_for_reset";
    watched.state.resetAt = scheduledAt;
    watched.state.resumesThisCycle = 0;
    watched.state.lastError = null;
  }

  const wl = loadWatchlist();
  upsertSession(wl, watched);
  saveWatchlist(wl);
  return { ok: true };
}

/** Accept an ISO string or a datetime-local value ("2026-07-17T15:30"). */
function parseWhen(v: string | undefined): Date | null {
  if (!v || !v.trim()) return null;
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Resume a watched session immediately, ignoring its trigger. Used by the
 * dashboard's "Resume now" so a user can verify the whole flow (or just nudge a
 * session onward) without waiting to actually hit a limit.
 */
export async function resumeNow(sessionId: string): Promise<{ ok: boolean; error?: string; summary?: string }> {
  const s = findSession(loadWatchlist(), sessionId);
  if (!s) return { ok: false, error: "That session isn't armed." };
  if (Date.parse(s.grant.expiresAt) < Date.now()) {
    return { ok: false, error: "This session's grant expired — turn it on again to set a new one." };
  }

  const result = await runResume({
    sessionId: s.sessionId,
    cwd: s.project,
    prompt: s.continuationPrompt,
    grant: s.grant,
  });
  saveRun(s.sessionId, s.continuationPrompt, result);
  if (!result.isAuthError && appStoreAvailable()) touchAppStoreSession(s.sessionId);

  // Re-load before writing: the resume can take minutes and the daemon may have
  // touched the watchlist in the meantime.
  const wl = loadWatchlist();
  const cur = findSession(wl, sessionId);
  if (cur) {
    cur.state.lastRun = {
      at: new Date().toISOString(),
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      terminalReason: result.terminalReason,
      isError: result.isError,
      permissionDenials: result.permissionDenials,
      resultPreview: result.resultText.slice(0, 300),
    };
    cur.state.resumesThisCycle += 1;
    cur.state.spentThisGrantUsd += result.costUsd;
    if (result.isAuthError) {
      cur.state.status = "auth_needed";
      cur.state.lastError = "Authentication failed (401). Reconnect Claude Code.";
    }
    saveWatchlist(wl);
  }

  if (result.isAuthError) return { ok: false, error: "Login expired — reconnect Claude Code." };
  if (result.isError) {
    return { ok: false, error: result.timedOut ? "The run timed out." : `Failed: ${result.resultText.slice(0, 120)}` };
  }
  const denials = result.permissionDenials.length ? `, ${result.permissionDenials.length} blocked` : "";
  const cost = result.costUsd ? `, $${result.costUsd.toFixed(2)}` : "";
  return { ok: true, summary: `${result.numTurns} turns${cost}, stopped ${result.terminalReason ?? "normally"}${denials}` };
}

export function setEnabled(sessionId: string, enabled: boolean): { ok: boolean; error?: string } {
  const wl = loadWatchlist();
  const s = findSession(wl, sessionId);
  if (!s) return { ok: false, error: "Not watched." };
  if (enabled && Date.parse(s.grant.expiresAt) < Date.now()) {
    return { ok: false, error: "Grant expired — re-arm this session to set a new grant." };
  }
  s.enabled = enabled;
  if (enabled && ["auth_needed", "error", "done", "expired"].includes(s.state.status)) {
    s.state.status = "watching";
    s.state.lastError = null;
  }
  saveWatchlist(wl);
  return { ok: true };
}

export function removeWatched(sessionId: string): { ok: boolean; error?: string } {
  const wl = loadWatchlist();
  if (!removeSession(wl, sessionId)) return { ok: false, error: "Not watched." };
  saveWatchlist(wl);
  return { ok: true };
}

export function setSettings(partial: Partial<StateResponse["settings"]>): { ok: boolean } {
  const wl = loadWatchlist();
  if (typeof partial.notifications === "boolean") wl.settings.notifications = partial.notifications;
  if (typeof partial.maxConcurrentResumes === "number") wl.settings.maxConcurrentResumes = Math.max(1, Math.floor(partial.maxConcurrentResumes));
  if (typeof partial.pollIntervalSec === "number") wl.settings.pollIntervalSec = Math.max(5, Math.floor(partial.pollIntervalSec));
  saveWatchlist(wl);
  return { ok: true };
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}
