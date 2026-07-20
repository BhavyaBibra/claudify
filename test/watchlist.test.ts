import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWatchlist, saveWatchlist, upsertSession, removeSession } from "../src/store/watchlist.js";
import { DEFAULT_CONTINUATION_PROMPT, type WatchedSession } from "../src/store/schema.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-wl-"));
  process.env.CLAUDIFY_HOME = home;
});
afterEach(() => {
  delete process.env.CLAUDIFY_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function sampleSession(id: string): WatchedSession {
  return {
    sessionId: id,
    project: "/Users/me/proj",
    transcriptPath: "/tmp/x.jsonl",
    enabled: true,
    priority: 1,
    continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
    trigger: "limit",
    scheduledAt: null,
    grant: {
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(npm test:*)"],
      model: "inherit",
      maxTurnsPerResume: 50,
      maxResumesPerLimitCycle: 3,
      expiresAt: new Date(Date.now() + 3600e3).toISOString(),
      consentedAt: new Date().toISOString(),
    },
    state: { status: "watching", limitHitAt: null, resetAt: null, resumesThisCycle: 0, relimitStreak: 0, spentThisGrantUsd: 0, lastRun: null, lastError: null },
  };
}

describe("watchlist store", () => {
  it("returns an empty watchlist when none exists", () => {
    const wl = loadWatchlist();
    expect(wl.version).toBe(1);
    expect(wl.sessions).toEqual([]);
  });

  it("round-trips through save/load", () => {
    const wl = loadWatchlist();
    upsertSession(wl, sampleSession("s1"));
    saveWatchlist(wl);
    const back = loadWatchlist();
    expect(back.sessions).toHaveLength(1);
    expect(back.sessions[0].sessionId).toBe("s1");
    expect(back.sessions[0].grant.permissionMode).toBe("acceptEdits");
  });

  it("upsert replaces an existing session by id", () => {
    const wl = loadWatchlist();
    upsertSession(wl, sampleSession("s1"));
    const updated = sampleSession("s1");
    updated.priority = 5;
    upsertSession(wl, updated);
    expect(wl.sessions).toHaveLength(1);
    expect(wl.sessions[0].priority).toBe(5);
  });

  it("removes a session", () => {
    const wl = loadWatchlist();
    upsertSession(wl, sampleSession("s1"));
    expect(removeSession(wl, "s1")).toBe(true);
    expect(wl.sessions).toHaveLength(0);
  });

  it("writes atomically (no leftover temp files)", () => {
    const wl = loadWatchlist();
    upsertSession(wl, sampleSession("s1"));
    saveWatchlist(wl);
    const leftovers = fs.readdirSync(home).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("throws on a corrupt watchlist file", () => {
    fs.writeFileSync(path.join(home, "watchlist.json"), "{ not json");
    expect(() => loadWatchlist()).toThrow();
  });

  it("rejects a schema-invalid watchlist", () => {
    fs.writeFileSync(path.join(home, "watchlist.json"), JSON.stringify({ version: 1, sessions: [{ sessionId: 123 }] }));
    expect(() => loadWatchlist()).toThrow();
  });
});
