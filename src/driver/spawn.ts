/**
 * The only place that spawns the `claude` CLI. Builds argv from a grant,
 * scrubs the environment (nested-session vars cause 401s — verified 2026-07-14),
 * enforces a wall-clock timeout, and parses the JSON result.
 */
import { spawn } from "node:child_process";
import type { Grant } from "../store/schema.js";
import { claudeBin } from "./claudeBin.js";

export interface ClaudeResult {
  ok: boolean;
  isError: boolean;
  apiErrorStatus: number | null;
  isAuthError: boolean;
  resultText: string;
  sessionId: string | null;
  numTurns: number;
  costUsd: number;
  terminalReason: string | null;
  permissionDenials: unknown[];
  timedOut: boolean;
  raw: unknown;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
}

export interface RunOptions {
  sessionId: string;
  cwd: string;
  prompt: string;
  grant: Grant;
  timeoutMs?: number;
  /** Override binary (tests point this at a shim). Defaults to $CLAUDIFY_CLAUDE_BIN or "claude". */
  bin?: string;
}

/** Environment variables that poison a nested `claude` invocation. */
const POISON_ENV_PREFIXES = ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK"];
const POISON_ENV_EXACT = ["ANTHROPIC_BASE_URL", "AI_AGENT", "CLAUDE_EFFORT", "BAGGAGE"];

/** Produce a scrubbed copy of the environment safe for a standalone `claude` run. */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (POISON_ENV_EXACT.includes(k)) continue;
    if (POISON_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/** Build the argv (after the binary) for a headless resume. */
export function buildArgs(opts: RunOptions): string[] {
  const { sessionId, prompt, grant } = opts;
  const args = [
    "-p",
    "--resume",
    sessionId,
    "--output-format",
    "json",
    "--permission-mode",
    grant.permissionMode,
    "--max-turns",
    String(grant.maxTurnsPerResume),
  ];
  if (grant.model && grant.model !== "inherit") {
    args.push("--model", grant.model);
  }
  if (grant.allowedTools.length > 0) {
    args.push("--allowedTools", ...grant.allowedTools);
  }
  // Prompt goes last as a positional argument.
  args.push(prompt);
  return args;
}

function parseResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The JSON result is the last complete JSON object printed.
  try {
    return JSON.parse(trimmed);
  } catch {
    const lastBrace = trimmed.lastIndexOf("{");
    if (lastBrace >= 0) {
      try {
        return JSON.parse(trimmed.slice(lastBrace));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isAuthErrorResult(status: number | null, text: string): boolean {
  if (status === 401) return true;
  return /invalid authentication|failed to authenticate|401/i.test(text);
}

export function runResume(opts: RunOptions): Promise<ClaudeResult> {
  const bin = opts.bin ?? claudeBin();
  const timeoutMs = opts.timeoutMs ?? 2 * 60 * 60 * 1000; // 2h wall-clock cap
  const args = buildArgs(opts);

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so we can kill the whole tree on timeout; otherwise a
      // killed shell can orphan a child that keeps the stdout pipe open.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 2000);
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(makeResult({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: null, timedOut }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(makeResult({ stdout, stderr, exitCode: code, timedOut }));
    });
  });
}

function makeResult(p: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): ClaudeResult {
  const raw = parseResult(p.stdout) as Record<string, unknown> | null;
  const resultText = (raw?.result as string) ?? (p.stdout.trim() || p.stderr.trim());
  const apiErrorStatus = (raw?.api_error_status as number | undefined) ?? null;
  const isError = Boolean(raw?.is_error) || p.timedOut || (p.exitCode !== null && p.exitCode !== 0 && !raw);
  return {
    ok: !isError && !p.timedOut,
    isError,
    apiErrorStatus,
    isAuthError: isAuthErrorResult(apiErrorStatus, resultText),
    resultText,
    sessionId: (raw?.session_id as string | undefined) ?? null,
    numTurns: (raw?.num_turns as number | undefined) ?? 0,
    costUsd: (raw?.total_cost_usd as number | undefined) ?? 0,
    terminalReason: (raw?.terminal_reason as string | undefined) ?? null,
    permissionDenials: (raw?.permission_denials as unknown[] | undefined) ?? [],
    timedOut: p.timedOut,
    raw,
    rawStdout: p.stdout,
    rawStderr: p.stderr,
    exitCode: p.exitCode,
  };
}
