import { describe, it, expect } from "vitest";
import { Scheduler, type SchedulerDeps } from "../src/daemon/scheduler.js";
import { computeResetTime } from "../src/driver/limit.js";
import { DEFAULT_CONTINUATION_PROMPT, type Watchlist, type WatchedSession } from "../src/store/schema.js";
import type { ClaudeResult } from "../src/driver/spawn.js";
import type { LimitEvent } from "../src/driver/transcript.js";

function baseResult(over: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    ok: true,
    isError: false,
    apiErrorStatus: null,
    isAuthError: false,
    resultText: "done",
    sessionId: "s1",
    numTurns: 5,
    costUsd: 0.01,
    terminalReason: "completed",
    permissionDenials: [],
    timedOut: false,
    raw: {},
    rawStdout: "",
    rawStderr: "",
    exitCode: 0,
    ...over,
  };
}

function session(over: Partial<WatchedSession> = {}): WatchedSession {
  return {
    sessionId: "s1",
    project: "/Users/me/proj",
    transcriptPath: "/tmp/s1.jsonl",
    enabled: true,
    priority: 1,
    continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
    trigger: "limit",
    scheduledAt: null,
    grant: {
      permissionMode: "acceptEdits",
      allowedTools: [],
      model: "inherit",
      maxTurnsPerResume: 50,
      maxResumesPerLimitCycle: 3,
      expiresAt: new Date(Date.now() + 24 * 3600e3).toISOString(),
      consentedAt: new Date().toISOString(),
    },
    state: { status: "watching", limitHitAt: null, resetAt: null, resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
    ...over,
  };
}

function watchlist(sessions: WatchedSession[]): Watchlist {
  return { version: 1, settings: { notifications: false, maxConcurrentResumes: 1, pollIntervalSec: 30 }, sessions };
}

interface Harness {
  scheduler: Scheduler;
  notes: string[];
  resumeCalls: WatchedSession[];
}

function makeHarness(opts: {
  limitEvent?: (path: string) => LimitEvent | null;
  resume?: (s: WatchedSession) => ClaudeResult;
}): Harness {
  const notes: string[] = [];
  const resumeCalls: WatchedSession[] = [];
  const deps: SchedulerDeps = {
    findLimitEvent: opts.limitEvent ?? (() => null),
    computeResetTime,
    runResume: async (s) => {
      resumeCalls.push({ ...s });
      return opts.resume ? opts.resume(s) : baseResult();
    },
    saveRun: () => "/tmp/run.json",
    notify: (t, m) => notes.push(`${t}: ${m}`),
    persist: () => {},
    log: () => {},
  };
  return { scheduler: new Scheduler(deps), notes, resumeCalls };
}

const limitAt6pm: LimitEvent = {
  parsed: { kind: "session", timeStr: "6pm", tz: "Asia/Calcutta" },
  rawText: "You've hit your session limit · resets 6pm (Asia/Calcutta)",
  at: "2026-07-14T00:00:00Z",
};

describe("Scheduler state machine", () => {
  it("watching -> waiting_for_reset when a limit is detected", async () => {
    const h = makeHarness({ limitEvent: () => limitAt6pm });
    const wl = watchlist([session()]);
    const now = new Date("2026-07-14T09:00:00Z"); // before 6pm IST
    await h.scheduler.tick(wl, now);
    expect(wl.sessions[0].state.status).toBe("waiting_for_reset");
    expect(wl.sessions[0].state.resetAt).toBeTruthy();
    expect(h.resumeCalls).toHaveLength(0);
  });

  it("does not resume before the reset time", async () => {
    const h = makeHarness({});
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T17:00:00Z"));
    expect(h.resumeCalls).toHaveLength(0);
    expect(wl.sessions[0].state.status).toBe("waiting_for_reset");
  });

  it("resumes at reset time and returns to watching on success", async () => {
    const h = makeHarness({ resume: () => baseResult({ numTurns: 20 }) });
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(h.resumeCalls).toHaveLength(1);
    expect(wl.sessions[0].state.status).toBe("watching");
    expect(wl.sessions[0].state.resumesThisCycle).toBe(1);
    expect(wl.sessions[0].state.lastRun?.numTurns).toBe(20);
  });

  it("stops with auth_needed on a 401", async () => {
    const h = makeHarness({ resume: () => baseResult({ isError: true, isAuthError: true, apiErrorStatus: 401 }) });
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(wl.sessions[0].state.status).toBe("auth_needed");
    expect(h.notes.join()).toMatch(/Auth failed/);
  });

  it("reschedules when a resume hits the limit again", async () => {
    // First tick resumes; the transcript then shows a fresh limit event.
    const h = makeHarness({
      limitEvent: () => limitAt6pm,
      resume: () => baseResult(),
    });
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T09:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T09:01:00Z"));
    expect(wl.sessions[0].state.status).toBe("waiting_for_reset");
    // A resume that immediately re-hit the limit did no real work, so it must
    // NOT consume a "times to continue" credit — only the streak advances.
    expect(wl.sessions[0].state.resumesThisCycle).toBe(0);
    expect(wl.sessions[0].state.relimitStreak).toBe(1);
  });

  it("pauses after too many consecutive re-limits (never really resetting)", async () => {
    const h = makeHarness({ limitEvent: () => limitAt6pm, resume: () => baseResult() });
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T09:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    for (let i = 0; i < 8; i++) {
      wl.sessions[0].state.resetAt = "2026-07-14T09:00:00Z"; // keep it due
      await h.scheduler.tick(wl, new Date("2026-07-14T09:01:00Z"));
    }
    expect(wl.sessions[0].state.status).toBe("error");
    expect(wl.sessions[0].state.resumesThisCycle).toBe(0); // never did real work
  });

  it("pauses when the spend cap is reached", async () => {
    // Each resume costs $2; cap is $3 → after the first run (spent $2) it's under,
    // but the accumulated spend crosses $3 on the second, pausing it.
    const h = makeHarness({ resume: () => baseResult({ costUsd: 2 }) });
    const s = session({
      grant: { ...session().grant, maxSpendUsd: 3, maxResumesPerLimitCycle: 10 },
      state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
    });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(wl.sessions[0].state.status).toBe("watching"); // spent $2, under $3
    expect(wl.sessions[0].state.spentThisGrantUsd).toBe(2);

    wl.sessions[0].state.status = "waiting_for_reset";
    wl.sessions[0].state.resetAt = "2026-07-14T18:00:00Z";
    await h.scheduler.tick(wl, new Date("2026-07-14T18:02:00Z"));
    expect(wl.sessions[0].state.spentThisGrantUsd).toBe(4); // $4 total
    expect(wl.sessions[0].state.status).toBe("done"); // crossed the $3 cap → paused
    expect(h.notes.join()).toMatch(/spend limit/i);
  });

  it("does not resume at all once already over the spend cap", async () => {
    const h = makeHarness({ resume: () => baseResult({ costUsd: 1 }) });
    const s = session({
      grant: { ...session().grant, maxSpendUsd: 5 },
      state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 6, lastRun: null, lastError: null },
    });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(h.resumeCalls).toHaveLength(0); // never ran — already over budget
    expect(wl.sessions[0].state.status).toBe("done");
  });

  it("marks done when the resume cap is reached", async () => {
    const h = makeHarness({ resume: () => baseResult() });
    const s = session({
      grant: { ...session().grant, maxResumesPerLimitCycle: 1 },
      state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
    });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(wl.sessions[0].state.status).toBe("done");
  });

  it("expires a session past its grant and disables it", async () => {
    const h = makeHarness({});
    const s = session({ grant: { ...session().grant, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date());
    expect(wl.sessions[0].state.status).toBe("expired");
    expect(wl.sessions[0].enabled).toBe(false);
    expect(h.notes.join()).toMatch(/expired/);
  });

  it("honors maxConcurrentResumes across multiple due sessions", async () => {
    const h = makeHarness({ resume: () => baseResult() });
    const mk = (id: string, prio: number) =>
      session({ sessionId: id, priority: prio, transcriptPath: `/tmp/${id}.jsonl`, state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([mk("b", 2), mk("a", 1)]);
    const count = await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(count).toBe(1); // single-flight
    // Highest priority (lowest number) went first.
    expect(h.resumeCalls[0].sessionId).toBe("a");
  });

  it("scheduled trigger: resumes at its set time without any limit event", async () => {
    // No limit event is ever reported; a scheduled session must still fire.
    const h = makeHarness({ limitEvent: () => null, resume: () => baseResult({ numTurns: 7 }) });
    const s = session({
      trigger: "scheduled",
      scheduledAt: "2026-07-14T18:00:00Z",
      state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
    });
    const wl = watchlist([s]);

    // Before the scheduled time: nothing.
    await h.scheduler.tick(wl, new Date("2026-07-14T17:59:00Z"));
    expect(h.resumeCalls).toHaveLength(0);

    // At/after the scheduled time: it resumes.
    await h.scheduler.tick(wl, new Date("2026-07-14T18:00:30Z"));
    expect(h.resumeCalls).toHaveLength(1);
    expect(wl.sessions[0].state.resumesThisCycle).toBe(1);
    expect(wl.sessions[0].state.lastRun?.numTurns).toBe(7);
  });

  it("scheduled trigger: still reschedules if the resume hits a real limit", async () => {
    const h = makeHarness({ limitEvent: () => limitAt6pm, resume: () => baseResult() });
    const s = session({
      trigger: "scheduled",
      scheduledAt: "2026-07-14T09:00:00Z",
      state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T09:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
    });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T09:01:00Z"));
    expect(h.resumeCalls).toHaveLength(1);
    expect(wl.sessions[0].state.status).toBe("waiting_for_reset"); // rescheduled to the real reset
  });

  it("skips disabled sessions", async () => {
    const h = makeHarness({ limitEvent: () => limitAt6pm });
    const s = session({ enabled: false });
    const wl = watchlist([s]);
    await h.scheduler.tick(wl, new Date("2026-07-14T09:00:00Z"));
    expect(wl.sessions[0].state.status).toBe("watching");
    expect(h.resumeCalls).toHaveLength(0);
  });

  it("retries once then errors on hard failures", async () => {
    const h = makeHarness({ resume: () => baseResult({ isError: true, timedOut: true, ok: false, terminalReason: null }) });
    const s = session({ state: { status: "waiting_for_reset", limitHitAt: null, resetAt: "2026-07-14T18:00:00Z", resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null } });
    const wl = watchlist([s]);
    // First failure -> retry scheduled.
    await h.scheduler.tick(wl, new Date("2026-07-14T18:01:00Z"));
    expect(wl.sessions[0].state.status).toBe("waiting_for_reset");
    expect(wl.sessions[0].state.resumesThisCycle).toBe(1);
    // Make the retry due and fail again -> error.
    wl.sessions[0].state.resetAt = "2026-07-14T18:02:00Z";
    await h.scheduler.tick(wl, new Date("2026-07-14T18:03:00Z"));
    expect(wl.sessions[0].state.status).toBe("error");
  });
});
