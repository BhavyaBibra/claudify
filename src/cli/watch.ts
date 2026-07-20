/**
 * `claudify watch` — the consent flow. Registers a session for auto-resume with
 * an explicit, user-confirmed permission grant. Interactive by default; fully
 * scriptable via flags (the /away skill drives it non-interactively, but the
 * grant answers still originate from the human).
 */
import { listSessions, inspectSession, type SessionInfo } from "../driver/transcript.js";
import { loadWatchlist, saveWatchlist, upsertSession } from "../store/watchlist.js";
import {
  DEFAULT_CONTINUATION_PROMPT,
  PermissionMode,
  type Grant,
  type WatchedSession,
} from "../store/schema.js";
import { withPrompt } from "../util/prompt.js";

export interface WatchFlags {
  session?: string;
  mode?: string;
  allow?: string[];
  model?: string;
  maxTurns?: number;
  maxResumes?: number;
  expiresIn?: string; // e.g. "12h", "2d"
  prompt?: string;
  priority?: number;
  yesIAcceptFullAutonomy?: boolean;
  fromSkill?: boolean;
}

const MODE_LABELS: Record<string, string> = {
  plan: "plan — read/plan only, zero writes (safest)",
  acceptEdits: "acceptEdits — edit files; risky Bash still blocks (recommended)",
  dontAsk: "dontAsk — run without prompts, limited to your allowlist",
  bypassPermissions: "bypassPermissions — FULL autonomy, no guardrails (dangerous)",
};

export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([hdm])$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : 60e3;
  return n * ms;
}

function resolveSession(idOrPrefix: string | undefined): SessionInfo | null {
  const all = listSessions();
  if (!idOrPrefix) {
    // Default: most recently active session in the current working directory.
    const cwd = process.cwd();
    const here = all.filter((s) => s.project === cwd);
    return (here[0] ?? all[0]) ?? null;
  }
  const exact = all.find((s) => s.sessionId === idOrPrefix);
  if (exact) return exact;
  const prefix = all.filter((s) => s.sessionId.startsWith(idOrPrefix));
  if (prefix.length === 1) return prefix[0];
  return null;
}

export async function runWatch(flags: WatchFlags): Promise<void> {
  const nonInteractive = flags.fromSkill || (flags.session != null && flags.mode != null);

  if (nonInteractive) {
    await watchNonInteractive(flags);
    return;
  }
  await watchInteractive(flags);
}

async function watchNonInteractive(flags: WatchFlags): Promise<void> {
  const session = resolveSession(flags.session);
  if (!session) {
    throw new Error(`No session found matching "${flags.session ?? "(cwd)"}".`);
  }
  const modeParse = PermissionMode.safeParse(flags.mode ?? "acceptEdits");
  if (!modeParse.success) {
    throw new Error(`Invalid --mode "${flags.mode}". Use one of: ${PermissionMode.options.join(", ")}.`);
  }
  if (modeParse.data === "bypassPermissions" && !flags.yesIAcceptFullAutonomy) {
    throw new Error("bypassPermissions requires --yes-i-accept-full-autonomy.");
  }
  const durMs = parseDuration(flags.expiresIn ?? "12h");
  if (durMs == null) throw new Error(`Invalid --expires-in "${flags.expiresIn}". Use e.g. 12h, 2d, 90m.`);

  const grant: Grant = {
    permissionMode: modeParse.data,
    allowedTools: flags.allow ?? [],
    model: flags.model ?? "inherit",
    maxTurnsPerResume: flags.maxTurns ?? 50,
    maxResumesPerLimitCycle: flags.maxResumes ?? 3,
    maxSpendUsd: 0,
    expiresAt: new Date(Date.now() + durMs).toISOString(),
    consentedAt: new Date().toISOString(),
  };
  register(session, grant, flags.prompt ?? DEFAULT_CONTINUATION_PROMPT, flags.priority ?? 1);
  printRegistered(session, grant);
}

async function watchInteractive(flags: WatchFlags): Promise<void> {
  await withPrompt(async (io) => {
    // 1. Choose the session.
    let session = resolveSession(flags.session);
    const all = listSessions();
    if (!flags.session) {
      const top = all.slice(0, 10);
      if (top.length === 0) throw new Error("No Claude Code sessions found under ~/.claude/projects.");
      const labels = top.map(
        (s) => `${projName(s.project)}  ${s.sessionId.slice(0, 8)}  "${s.summary}"  (${rel(s.lastActivity)})`,
      );
      const idx = await io.choose("Which session should Claudify watch?", labels, 0);
      session = top[idx];
    }
    if (!session) throw new Error("No matching session.");

    console.log(`\nSession: ${session.sessionId}\nProject: ${session.project}\n`);

    // 2. Permission grant (the consent step).
    console.log("Claudify will resume this session unattended after limit resets.");
    console.log("Choose how much it is allowed to do while you're away:\n");
    const modeKeys = ["plan", "acceptEdits", "dontAsk", "bypassPermissions"] as const;
    const modeIdx = await io.choose(
      "Permission level:",
      modeKeys.map((k) => MODE_LABELS[k]),
      1, // default acceptEdits
    );
    const mode = modeKeys[modeIdx];

    if (mode === "bypassPermissions") {
      const sure = await io.confirm(
        "\n⚠️  bypassPermissions gives the unattended session FULL autonomy with no guardrails. Are you absolutely sure?",
        false,
      );
      if (!sure) {
        console.log("Aborted. Re-run and pick a safer level.");
        return;
      }
    }

    let allow: string[] = [];
    if (mode === "dontAsk" || mode === "acceptEdits") {
      const raw = await io.ask(
        "Allowed tool patterns (comma-separated, e.g. Bash(npm test:*),Bash(git commit:*)) — blank for none:",
        "",
      );
      allow = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // 3. Caps.
    const maxTurns = Number(await io.ask("Max turns per resume:", "50")) || 50;
    const maxResumes = Number(await io.ask("Max resumes per limit cycle:", "3")) || 3;
    const expiresRaw = await io.ask("Grant expires in (e.g. 12h, 2d):", "12h");
    const durMs = parseDuration(expiresRaw) ?? parseDuration("12h")!;

    // 4. Continuation prompt.
    const useDefault = await io.confirm("\nUse the default away-plan continuation prompt?", true);
    const prompt = useDefault
      ? DEFAULT_CONTINUATION_PROMPT
      : await io.ask("Continuation prompt:", DEFAULT_CONTINUATION_PROMPT);

    const priority = Number(await io.ask("Priority (lower resumes first):", "1")) || 1;

    const grant: Grant = {
      permissionMode: mode,
      allowedTools: allow,
      model: flags.model ?? "inherit",
      maxTurnsPerResume: maxTurns,
      maxResumesPerLimitCycle: maxResumes,
    maxSpendUsd: 0,
      expiresAt: new Date(Date.now() + durMs).toISOString(),
      consentedAt: new Date().toISOString(),
    };

    console.log("\nAbout to register with this grant:");
    console.log(summarizeGrant(grant));
    const ok = await io.confirm("\nConfirm and enable auto-resume for this session?", true);
    if (!ok) {
      console.log("Aborted. Nothing was saved.");
      return;
    }
    register(session, grant, prompt, priority);
    printRegistered(session, grant);
  });
}

function register(session: SessionInfo, grant: Grant, prompt: string, priority: number): void {
  // Refresh transcript path/project from disk in case it moved.
  const fresh = inspectSession(session.transcriptPath) ?? session;
  const watched: WatchedSession = {
    sessionId: fresh.sessionId,
    project: fresh.project,
    transcriptPath: fresh.transcriptPath,
    enabled: true,
    priority,
    goal: "",
    continuationPrompt: prompt,
    trigger: "limit",
    scheduledAt: null,
    grant,
    state: {
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
  const wl = loadWatchlist();
  upsertSession(wl, watched);
  saveWatchlist(wl);
}

function printRegistered(session: SessionInfo, grant: Grant): void {
  console.log(`\n✓ Watching ${projName(session.project)} (${session.sessionId.slice(0, 8)}).`);
  console.log(summarizeGrant(grant));
  console.log("\nMake sure the daemon is running:  claudify daemon status");
}

function summarizeGrant(g: Grant): string {
  const lines = [
    `  mode:        ${g.permissionMode}`,
    `  allowed:     ${g.allowedTools.length ? g.allowedTools.join(", ") : "(none)"}`,
    `  model:       ${g.model}`,
    `  max turns:   ${g.maxTurnsPerResume} per resume`,
    `  max resumes: ${g.maxResumesPerLimitCycle} per limit cycle`,
    `  expires:     ${new Date(g.expiresAt).toLocaleString()}`,
  ];
  return lines.join("\n");
}

function projName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function rel(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return "?";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
