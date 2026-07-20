import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSession, findLimitEvent, readTailLines } from "../src/driver/transcript.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-tr-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, records: unknown[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

describe("inspectSession", () => {
  it("reads sessionId, cwd, summary, and last activity", () => {
    const p = writeJsonl("abc123.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/Users/me/proj", message: { role: "user", content: "Build the thing please" } },
      { type: "assistant", timestamp: "2026-07-14T00:01:00Z", message: { role: "assistant", content: "on it" } },
    ]);
    const info = inspectSession(p)!;
    expect(info.sessionId).toBe("abc123");
    expect(info.project).toBe("/Users/me/proj");
    expect(info.summary).toBe("Build the thing please");
    expect(info.lastActivity).toBe("2026-07-14T00:01:00Z");
  });

  it("uses the Claude-app title: custom-title wins over ai-title", () => {
    const p = writeJsonl("t.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/p", message: { role: "user", content: "do a thing" } },
      { type: "ai-title", sessionId: "t", aiTitle: "Auto generated title" },
      { type: "custom-title", sessionId: "t", customTitle: "My renamed session" },
    ]);
    const info = inspectSession(p)!;
    expect(info.title).toBe("My renamed session");
    expect(info.hasRealTitle).toBe(true);
  });

  it("falls back to ai-title when no custom title, and to summary when neither", () => {
    const withAi = writeJsonl("a.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/p", message: { role: "user", content: "hello" } },
      { type: "ai-title", sessionId: "a", aiTitle: "Fix the parser" },
    ]);
    expect(inspectSession(withAi)!.title).toBe("Fix the parser");

    const none = writeJsonl("n.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/p", message: { role: "user", content: "just the first message" } },
    ]);
    const info = inspectSession(none)!;
    expect(info.title).toBe("just the first message");
    expect(info.hasRealTitle).toBe(false);
  });

  it("skips system-reminder-style first messages for the summary", () => {
    const p = writeJsonl("x.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/p", message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } },
      { type: "user", timestamp: "2026-07-14T00:00:01Z", cwd: "/p", message: { role: "user", content: "real request here" } },
    ]);
    expect(inspectSession(p)!.summary).toBe("real request here");
  });
});

describe("findLimitEvent", () => {
  it("detects a limit message as the latest turn", () => {
    const p = writeJsonl("s.jsonl", [
      { type: "user", timestamp: "2026-07-14T00:00:00Z", cwd: "/p", message: { role: "user", content: "go" } },
      { type: "assistant", timestamp: "2026-07-14T00:05:00Z", isApiErrorMessage: true, message: { role: "assistant", content: "You've hit your session limit · resets 6pm (Asia/Calcutta)" } },
    ]);
    const evt = findLimitEvent(p)!;
    expect(evt.parsed.kind).toBe("session");
    expect(evt.parsed.timeStr).toBe("6pm");
    expect(evt.parsed.tz).toBe("Asia/Calcutta");
    expect(evt.at).toBe("2026-07-14T00:05:00Z");
  });

  it("returns null when the latest turn is normal work", () => {
    const p = writeJsonl("s.jsonl", [
      { type: "assistant", timestamp: "2026-07-14T00:05:00Z", isApiErrorMessage: true, message: { role: "assistant", content: "You've hit your session limit · resets 6pm (Asia/Calcutta)" } },
      { type: "assistant", timestamp: "2026-07-14T00:10:00Z", message: { role: "assistant", content: "back to work, all done" } },
    ]);
    expect(findLimitEvent(p)).toBeNull();
  });

  it("flags an unparseable limit message with empty time fields", () => {
    const p = writeJsonl("s.jsonl", [
      { type: "assistant", timestamp: "2026-07-14T00:05:00Z", isApiErrorMessage: true, message: { role: "assistant", content: "You've hit your session limit, try later" } },
    ]);
    const evt = findLimitEvent(p)!;
    expect(evt.parsed.timeStr).toBe("");
  });
});

describe("readTailLines", () => {
  it("returns trailing complete lines for a large file", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ n: i }));
    const p = path.join(tmp, "big.jsonl");
    fs.writeFileSync(p, lines.join("\n") + "\n");
    const tail = readTailLines(p, 4096);
    expect(tail.length).toBeGreaterThan(0);
    const last = JSON.parse(tail[tail.length - 1]);
    expect(last.n).toBe(4999);
    // Every returned line must be complete JSON (no partial first line).
    for (const l of tail) expect(() => JSON.parse(l)).not.toThrow();
  });
});
