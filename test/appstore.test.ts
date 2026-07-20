import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAppStoreSessions,
  findByCliSessionId,
  touchAppStoreSession,
  appStoreAvailable,
} from "../src/driver/appstore.js";

let root: string;

function writeSession(name: string, data: Record<string, unknown>): string {
  const dir = path.join(root, "acct", "org");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-appstore-"));
  process.env.CLAUDIFY_APPSTORE_DIR = root;
});
afterEach(() => {
  delete process.env.CLAUDIFY_APPSTORE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("app store reading", () => {
  it("reports availability from the configured root", () => {
    expect(appStoreAvailable()).toBe(true);
  });

  it("lists non-archived sessions newest-first", () => {
    writeSession("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", title: "Older", lastActivityAt: 100, isArchived: false });
    writeSession("local_b.json", { sessionId: "local_b", cliSessionId: "cli-b", title: "Newer", lastActivityAt: 200, isArchived: false });
    writeSession("local_c.json", { sessionId: "local_c", cliSessionId: "cli-c", title: "Archived", lastActivityAt: 300, isArchived: true });
    const list = listAppStoreSessions();
    expect(list.map((s) => s.title)).toEqual(["Newer", "Older"]); // archived excluded, newest first
  });

  it("finds a session by CLI session id", () => {
    writeSession("local_x.json", { sessionId: "local_x", cliSessionId: "the-cli-id", title: "X", lastActivityAt: 1, isArchived: false, completedTurns: 3 });
    const s = findByCliSessionId("the-cli-id")!;
    expect(s.title).toBe("X");
    expect(s.completedTurns).toBe(3);
    expect(findByCliSessionId("missing")).toBeNull();
  });
});

describe("touchAppStoreSession", () => {
  it("bumps lastActivityAt and increments completedTurns, moving it to the top", () => {
    writeSession("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", title: "A", lastActivityAt: 100, isArchived: false, completedTurns: 1 });
    writeSession("local_b.json", { sessionId: "local_b", cliSessionId: "cli-b", title: "B", lastActivityAt: 999999999999, isArchived: false, completedTurns: 5 });

    expect(listAppStoreSessions()[0].title).toBe("B"); // B is newest initially

    const at = Date.now() + 1_000_000;
    expect(touchAppStoreSession("cli-a", { at })).toBe(true);

    const a = findByCliSessionId("cli-a")!;
    expect(a.lastActivityAt).toBe(at);
    expect(a.completedTurns).toBe(2); // incremented by one
    expect(listAppStoreSessions()[0].title).toBe("A"); // now on top
  });

  it("preserves all other fields when touching", () => {
    const file = writeSession("local_a.json", {
      sessionId: "local_a", cliSessionId: "cli-a", title: "Keep me", cwd: "/proj",
      permissionMode: "acceptEdits", model: "claude-opus-4-8", isArchived: false,
      lastActivityAt: 1, completedTurns: 1, prNumber: 7,
    });
    touchAppStoreSession("cli-a");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.title).toBe("Keep me");
    expect(raw.permissionMode).toBe("acceptEdits");
    expect(raw.model).toBe("claude-opus-4-8");
    expect(raw.prNumber).toBe(7);
  });

  it("returns false for an unknown session and leaves no temp files", () => {
    writeSession("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", title: "A", lastActivityAt: 1, isArchived: false });
    expect(touchAppStoreSession("nope")).toBe(false);
    const leftovers = fs.readdirSync(path.join(root, "acct", "org")).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
