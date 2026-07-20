import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArgs, cleanEnv, runResume } from "../src/driver/spawn.js";
import type { Grant } from "../src/store/schema.js";

const SHIM = path.resolve(__dirname, "fixtures/fake-claude.sh");

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    permissionMode: "acceptEdits",
    allowedTools: [],
    model: "inherit",
    maxTurnsPerResume: 50,
    maxResumesPerLimitCycle: 3,
    expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    consentedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildArgs", () => {
  it("builds a resume command with the grant's mode and caps", () => {
    const args = buildArgs({ sessionId: "s1", cwd: "/p", prompt: "Continue.", grant: grant() });
    expect(args).toContain("--resume");
    expect(args).toContain("s1");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).toContain("--max-turns");
    expect(args).toContain("50");
    expect(args[args.length - 1]).toBe("Continue.");
    expect(args).not.toContain("--model"); // inherit => omitted
  });

  it("includes model and allowlist when set", () => {
    const args = buildArgs({
      sessionId: "s1",
      cwd: "/p",
      prompt: "go",
      grant: grant({ model: "claude-opus-4-8", allowedTools: ["Bash(npm test:*)", "Edit"] }),
    });
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-8");
    const ai = args.indexOf("--allowedTools");
    expect(ai).toBeGreaterThan(-1);
    expect(args[ai + 1]).toBe("Bash(npm test:*)");
    expect(args[ai + 2]).toBe("Edit");
  });
});

describe("cleanEnv", () => {
  it("strips nested-session poison vars but keeps the rest", () => {
    const env = cleanEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_BASE_URL: "http://internal",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_AGENT_SDK_VERSION: "0.3",
      AI_AGENT: "claude-code",
      ANTHROPIC_API_KEY: "sk-keep-me",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-keep-me");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.AI_AGENT).toBeUndefined();
  });
});

describe("runResume with the fake claude shim", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-spawn-"));
    fs.chmodSync(SHIM, 0o755);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
  });

  it("parses a successful result", async () => {
    process.env.FAKE_CLAUDE_MODE = "success";
    const res = await runResume({ sessionId: "s1", cwd: tmp, prompt: "Continue.", grant: grant(), bin: SHIM });
    expect(res.ok).toBe(true);
    expect(res.isError).toBe(false);
    expect(res.resultText).toBe("PONG");
    expect(res.numTurns).toBe(12);
    expect(res.costUsd).toBeCloseTo(0.01);
  });

  it("detects an auth failure", async () => {
    process.env.FAKE_CLAUDE_MODE = "authfail";
    const res = await runResume({ sessionId: "s1", cwd: tmp, prompt: "go", grant: grant(), bin: SHIM });
    expect(res.isError).toBe(true);
    expect(res.isAuthError).toBe(true);
    expect(res.apiErrorStatus).toBe(401);
  });

  it("treats a nonzero crash exit with no JSON as an error", async () => {
    process.env.FAKE_CLAUDE_MODE = "crash";
    const res = await runResume({ sessionId: "s1", cwd: tmp, prompt: "go", grant: grant(), bin: SHIM });
    expect(res.isError).toBe(true);
    expect(res.exitCode).toBe(3);
  });

  it("enforces the wall-clock timeout", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const res = await runResume({ sessionId: "s1", cwd: tmp, prompt: "go", grant: grant(), bin: SHIM, timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(res.isError).toBe(true);
  });

  it("passes the built argv to the binary", async () => {
    const argsFile = path.join(tmp, "args.txt");
    process.env.FAKE_CLAUDE_MODE = "success";
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    await runResume({ sessionId: "s1", cwd: tmp, prompt: "Continue.", grant: grant(), bin: SHIM });
    const received = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    expect(received).toContain("--resume");
    expect(received).toContain("s1");
    expect(received[received.length - 1]).toBe("Continue.");
  });
});
