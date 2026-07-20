import { z } from "zod";

export const PermissionMode = z.enum([
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "default",
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Grant = z.object({
  permissionMode: PermissionMode,
  allowedTools: z.array(z.string()).default([]),
  /** "inherit" means don't pass --model (use the session's own default). */
  model: z.string().default("inherit"),
  maxTurnsPerResume: z.number().int().positive().max(1000).default(50),
  maxResumesPerLimitCycle: z.number().int().positive().max(100).default(3),
  /** USD spend ceiling across the whole grant; 0 = no limit. Bounds runaway cost
   *  on large sessions where each turn reprocesses a lot of context. */
  maxSpendUsd: z.number().nonnegative().default(0),
  /** ISO timestamp after which the grant is void and the session won't resume. */
  expiresAt: z.string(),
  consentedAt: z.string(),
});
export type Grant = z.infer<typeof Grant>;

export const SessionStatus = z.enum([
  "watching",
  "waiting_for_reset",
  "resuming",
  "done",
  "error",
  "auth_needed",
  "expired",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const LastRun = z.object({
  at: z.string(),
  numTurns: z.number().default(0),
  costUsd: z.number().default(0),
  terminalReason: z.string().nullable().default(null),
  isError: z.boolean().default(false),
  permissionDenials: z.array(z.unknown()).default([]),
  resultPreview: z.string().default(""),
});
export type LastRun = z.infer<typeof LastRun>;

export const SessionState = z.object({
  status: SessionStatus.default("watching"),
  limitHitAt: z.string().nullable().default(null),
  resetAt: z.string().nullable().default(null),
  resumesThisCycle: z.number().int().default(0),
  /** Consecutive resumes that immediately re-hit the limit (did no real work).
   *  These don't count against `resumesThisCycle`; this bounds pathological loops. */
  relimitStreak: z.number().int().default(0),
  /** Cumulative USD spent by resumes under the current grant (for the spend cap). */
  spentThisGrantUsd: z.number().default(0),
  lastRun: LastRun.nullable().default(null),
  lastError: z.string().nullable().default(null),
});
export type SessionState = z.infer<typeof SessionState>;

export const WatchedSession = z.object({
  sessionId: z.string(),
  project: z.string(),
  transcriptPath: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(1),
  /** The raw objective the user typed (for display/editing); "" if none.
   *  The actual prompt sent is `continuationPrompt`, composed from this. */
  goal: z.string().default(""),
  continuationPrompt: z.string(),
  /**
   * What starts the first resume:
   *  - "limit"     : wait for the session to actually hit its usage limit, then
   *                  resume at the reset time parsed from that message.
   *  - "scheduled" : resume at `scheduledAt` regardless of a limit event — for
   *                  people who are near their limit but haven't hit it yet and
   *                  already know when their window resets.
   * After the first resume, both behave the same: if a fresh limit appears the
   * session reschedules to that reset, subject to the grant's caps.
   */
  trigger: z.enum(["limit", "scheduled"]).default("limit"),
  /** ISO timestamp for the "scheduled" trigger. Null for "limit". */
  scheduledAt: z.string().nullable().default(null),
  grant: Grant,
  state: SessionState.default({
    status: "watching",
    limitHitAt: null,
    resetAt: null,
    resumesThisCycle: 0,
    lastRun: null,
    lastError: null,
  }),
});
export type WatchedSession = z.infer<typeof WatchedSession>;

export const Settings = z.object({
  notifications: z.boolean().default(true),
  maxConcurrentResumes: z.number().int().positive().default(1),
  /** Watcher poll interval in seconds. */
  pollIntervalSec: z.number().int().positive().default(30),
  /** Whether the daemon also hosts the dashboard. */
  dashboardEnabled: z.boolean().default(true),
  /** Port the dashboard listens on. */
  dashboardPort: z.number().int().positive().default(4177),
});
export type Settings = z.infer<typeof Settings>;

export const Watchlist = z.object({
  version: z.literal(1).default(1),
  settings: Settings.default({ notifications: true, maxConcurrentResumes: 1, pollIntervalSec: 30, dashboardEnabled: true, dashboardPort: 4177 }),
  sessions: z.array(WatchedSession).default([]),
});
export type Watchlist = z.infer<typeof Watchlist>;

/**
 * Build the prompt sent on every resume. Because `claude -p --resume` reloads
 * the full session history, the resumed model can see everything it already did
 * — so the prompt's job is to say "continue, don't repeat, stop when done"
 * rather than re-issue a task. This makes repeated resumes idempotent and
 * self-terminating: if the goal is already met, Claude just reports done and
 * stops, so a later resume can't send it in circles.
 *
 * @param goal Optional user-provided objective (from the dashboard's "what
 *             should it work on" field). Treated as a target, never a command
 *             to blindly rerun.
 */
export function composeContinuationPrompt(goal?: string): string {
  const head =
    "You were resumed automatically by Claudify after your usage limit reset. " +
    "This is the SAME session — scroll back and check what you have ALREADY done " +
    "in this conversation, and do NOT repeat work that is already complete.";
  const body = goal && goal.trim()
    ? " The objective for this session is: " + goal.trim().replace(/[.\s]*$/, "") + ". " +
      "Continue toward that objective from wherever you actually left off. " +
      "If it is already fully done, say so briefly and stop — do not redo it."
    : " If a .claudify/AWAY_PLAN.md file exists, follow it (do the top unchecked " +
      "task, update its Progress log). Otherwise, continue the unfinished work " +
      "from where you left off. If there is nothing left to do, say so and stop.";
  const tail =
    " If a command is blocked because you don't have permission for it, do NOT " +
    "retry it over and over — note what access you'd need, work around it if you " +
    "can, otherwise stop. Before you stop, briefly summarize what you did this " +
    "run and what (if anything) still remains.";
  return head + body + tail;
}

/** Default when the user gives no specific objective. */
export const DEFAULT_CONTINUATION_PROMPT = composeContinuationPrompt();

export function emptyWatchlist(): Watchlist {
  return Watchlist.parse({});
}
