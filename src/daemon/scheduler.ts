/**
 * The scheduling state machine. Pure of I/O timing: `tick(now)` is called by the
 * daemon loop (or by tests) and drives each watched session through its states.
 * Dependencies (transcript reading, executor, notifier, persistence) are injected
 * so the whole thing is testable offline. No Claude-specific knowledge lives here
 * beyond what the injected driver functions expose.
 */
import type { Watchlist, WatchedSession } from "../store/schema.js";
import type { ClaudeResult } from "../driver/spawn.js";
import type { LimitEvent } from "../driver/transcript.js";

export interface SchedulerDeps {
  /** Inspect a transcript for a fresh limit event (null if not blocked). */
  findLimitEvent: (transcriptPath: string) => LimitEvent | null;
  /** Turn a parsed limit event into a concrete reset Date (null if unparseable). */
  computeResetTime: (timeStr: string, tz: string, now: Date) => Date | null;
  /** Execute a headless resume. */
  runResume: (session: WatchedSession, prompt: string) => Promise<ClaudeResult>;
  /** Persist a run artifact; returns file path. */
  saveRun: (session: WatchedSession, prompt: string, result: ClaudeResult) => string;
  /** Emit a notification. */
  notify: (title: string, message: string) => void;
  /** Persist the whole watchlist after mutations. */
  persist: (wl: Watchlist) => void;
  /** Structured log. */
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** Fallback poll interval when a limit message can't be parsed. */
const UNPARSEABLE_RETRY_MS = 15 * 60 * 1000;

/** Max consecutive resumes that immediately re-hit the limit before pausing. */
const MAX_RELIMIT_STREAK = 6;

export class Scheduler {
  constructor(private deps: SchedulerDeps) {}

  /** Run one scheduling pass. Returns number of resumes performed this tick. */
  async tick(wl: Watchlist, now: Date = new Date()): Promise<number> {
    let mutated = false;
    let resumesThisTick = 0;
    const maxConcurrent = wl.settings.maxConcurrentResumes;

    // Sort candidates by priority so that, when several are due, the important
    // ones resume first (they share one quota).
    const active = wl.sessions
      .filter((s) => s.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const s of active) {
      // 1. Grant expiry is checked before anything else.
      if (this.isExpired(s, now)) {
        if (s.state.status !== "expired") {
          s.state.status = "expired";
          s.enabled = false;
          mutated = true;
          this.deps.log("grant_expired", { sessionId: s.sessionId });
          this.deps.notify("Claudify", `Away grant expired for ${shortProj(s)}; auto-resume disabled.`);
        }
        continue;
      }

      // Terminal states do nothing further.
      if (s.state.status === "auth_needed" || s.state.status === "done" || s.state.status === "error") {
        continue;
      }

      if (s.state.status === "watching") {
        if (this.detectLimit(s, now)) mutated = true;
        continue;
      }

      if (s.state.status === "waiting_for_reset") {
        const resetAt = s.state.resetAt ? Date.parse(s.state.resetAt) : NaN;
        if (Number.isNaN(resetAt) || now.getTime() >= resetAt) {
          if (resumesThisTick >= maxConcurrent) continue; // single-flight per tick
          const did = await this.doResume(s, now);
          if (did) {
            resumesThisTick++;
            mutated = true;
          }
        }
        continue;
      }
    }

    if (mutated) this.deps.persist(wl);
    return resumesThisTick;
  }

  private isExpired(s: WatchedSession, now: Date): boolean {
    const exp = Date.parse(s.grant.expiresAt);
    return !Number.isNaN(exp) && now.getTime() > exp;
  }

  /** In `watching`: look for a limit event and transition to waiting_for_reset. */
  private detectLimit(s: WatchedSession, now: Date): boolean {
    const evt = this.deps.findLimitEvent(s.transcriptPath);
    if (!evt) return false;

    s.state.limitHitAt = evt.at ?? now.toISOString();

    if (!evt.parsed.timeStr || !evt.parsed.tz) {
      // Recognized as a limit message but couldn't parse the reset time.
      const retryAt = new Date(now.getTime() + UNPARSEABLE_RETRY_MS);
      s.state.resetAt = retryAt.toISOString();
      s.state.status = "waiting_for_reset";
      this.deps.log("limit_detected_unparseable", { sessionId: s.sessionId, rawText: evt.rawText });
      this.deps.notify(
        "Claudify",
        `${shortProj(s)} hit a limit but the reset time was unreadable; will retry every 15 min.`,
      );
      return true;
    }

    const reset = this.deps.computeResetTime(evt.parsed.timeStr, evt.parsed.tz, now);
    if (!reset) {
      const retryAt = new Date(now.getTime() + UNPARSEABLE_RETRY_MS);
      s.state.resetAt = retryAt.toISOString();
      s.state.status = "waiting_for_reset";
      this.deps.log("limit_reset_uncomputable", { sessionId: s.sessionId, timeStr: evt.parsed.timeStr, tz: evt.parsed.tz });
      return true;
    }

    s.state.resetAt = reset.toISOString();
    s.state.status = "waiting_for_reset";
    this.deps.log("limit_detected", {
      sessionId: s.sessionId,
      resetAt: s.state.resetAt,
      kind: evt.parsed.kind,
    });
    this.deps.notify(
      "Claudify",
      `${shortProj(s)} hit its limit; will resume at ${formatLocal(reset)}.`,
    );
    return true;
  }

  /** In `waiting_for_reset` and due: perform the resume and route the outcome. */
  private async doResume(s: WatchedSession, now: Date): Promise<boolean> {
    // Spend cap: if this grant has already spent its budget, stop before running.
    if (this.overBudget(s)) {
      s.state.status = "done";
      s.state.lastError = `Spend limit reached ($${s.state.spentThisGrantUsd.toFixed(2)} of $${s.grant.maxSpendUsd.toFixed(2)}).`;
      this.deps.log("resume_budget_reached", { sessionId: s.sessionId, spent: s.state.spentThisGrantUsd, cap: s.grant.maxSpendUsd });
      this.deps.notify("Claudify", `${shortProj(s)} hit its $${s.grant.maxSpendUsd.toFixed(2)} spend limit; auto-resume paused.`);
      return true;
    }

    s.state.status = "resuming";
    this.deps.log("resume_start", { sessionId: s.sessionId, attempt: s.state.resumesThisCycle + 1 });

    const result = await this.deps.runResume(s, s.continuationPrompt);
    this.deps.saveRun(s, s.continuationPrompt, result);
    s.state.lastRun = {
      at: new Date().toISOString(),
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      terminalReason: result.terminalReason,
      isError: result.isError,
      permissionDenials: result.permissionDenials,
      resultPreview: result.resultText.slice(0, 300),
    };

    // Auth failure — stop and shout. (Doesn't count against the cycle.)
    if (result.isAuthError) {
      s.state.status = "auth_needed";
      s.state.lastError = "Authentication failed (401). Run `claude` in a terminal and /login, then re-enable.";
      this.deps.log("resume_auth_needed", { sessionId: s.sessionId });
      this.deps.notify("Claudify — action needed", `Auth failed for ${shortProj(s)}. Run claude /login, then \`claudify on\`.`);
      return true;
    }

    // The resume immediately hit the limit again — it did NO real work (the usage
    // window hadn't truly reset; the reported reset time often rolls later). Do
    // NOT spend a "times to continue" credit on this; just reschedule to the new
    // reset. A separate streak counter bounds pathological loops.
    const evt = this.deps.findLimitEvent(s.transcriptPath);
    if (evt && evt.parsed.timeStr && evt.parsed.tz) {
      const reset = this.deps.computeResetTime(evt.parsed.timeStr, evt.parsed.tz, now);
      if (reset) {
        s.state.relimitStreak += 1;
        if (s.state.relimitStreak > MAX_RELIMIT_STREAK) {
          s.state.status = "error";
          s.state.lastError = "Kept hitting the limit without a real reset; paused. The window may not have reset yet.";
          this.deps.log("resume_relimit_giveup", { sessionId: s.sessionId, streak: s.state.relimitStreak });
          this.deps.notify("Claudify", `${shortProj(s)} keeps hitting its limit; paused. Try again later.`);
          return true;
        }
        s.state.resetAt = reset.toISOString();
        s.state.status = "waiting_for_reset";
        this.deps.log("resume_hit_limit_again", { sessionId: s.sessionId, resetAt: s.state.resetAt, streak: s.state.relimitStreak });
        if (s.state.relimitStreak === 1) {
          // Only notify on the first re-limit of a streak, to avoid spam.
          this.deps.notify("Claudify", `${shortProj(s)} isn't reset yet; will retry at ${formatLocal(reset)}.`);
        }
        return true;
      }
    }

    // Past here the resume actually did work (or hard-errored) — it counts.
    s.state.resumesThisCycle += 1;
    s.state.relimitStreak = 0;
    s.state.spentThisGrantUsd += result.costUsd;

    // Hard error (timeout / crash) — retry once, then give up this cycle.
    if (result.isError && !result.isAuthError) {
      if (s.state.resumesThisCycle < 2) {
        s.state.status = "waiting_for_reset";
        s.state.resetAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
        s.state.lastError = result.timedOut ? "Run timed out; retrying once." : "Run errored; retrying once.";
        this.deps.log("resume_error_retry", { sessionId: s.sessionId, timedOut: result.timedOut });
        return true;
      }
      s.state.status = "error";
      s.state.lastError = result.timedOut ? "Run timed out twice." : `Run errored: ${result.resultText.slice(0, 120)}`;
      this.deps.notify("Claudify", `${shortProj(s)} errored twice; auto-resume paused. See \`claudify logs\`.`);
      return true;
    }

    // Successful run. If caps allow, keep watching for the next limit event
    // (the away plan may have more to do). Otherwise we're done.
    const denialNote = result.permissionDenials.length
      ? ` (${result.permissionDenials.length} commands blocked — widen access if that stalled it)`
      : "";
    const costNote = result.costUsd ? ` · $${result.costUsd.toFixed(2)}` : "";
    this.deps.notify(
      "Claudify",
      `Resumed ${shortProj(s)}: ${result.numTurns} turns${costNote}, stopped ${result.terminalReason ?? "normally"}${denialNote}.`,
    );
    this.deps.log("resume_success", {
      sessionId: s.sessionId,
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      spentTotal: s.state.spentThisGrantUsd,
      denials: result.permissionDenials.length,
    });

    if (this.overBudget(s)) {
      s.state.status = "done";
      s.state.lastError = `Spend limit reached ($${s.state.spentThisGrantUsd.toFixed(2)} of $${s.grant.maxSpendUsd.toFixed(2)}).`;
      this.deps.log("resume_budget_reached", { sessionId: s.sessionId, spent: s.state.spentThisGrantUsd, cap: s.grant.maxSpendUsd });
      this.deps.notify("Claudify", `${shortProj(s)} reached its $${s.grant.maxSpendUsd.toFixed(2)} spend limit; paused.`);
    } else if (this.underCap(s)) {
      s.state.status = "watching";
    } else {
      s.state.status = "done";
      this.deps.log("cycle_cap_reached", { sessionId: s.sessionId, cap: s.grant.maxResumesPerLimitCycle });
    }
    return true;
  }

  private underCap(s: WatchedSession): boolean {
    return s.state.resumesThisCycle < s.grant.maxResumesPerLimitCycle;
  }

  private overBudget(s: WatchedSession): boolean {
    return s.grant.maxSpendUsd > 0 && s.state.spentThisGrantUsd >= s.grant.maxSpendUsd;
  }
}

function shortProj(s: WatchedSession): string {
  const parts = s.project.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? s.project;
}

function formatLocal(d: Date): string {
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}
