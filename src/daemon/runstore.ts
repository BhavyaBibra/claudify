import fs from "node:fs";
import path from "node:path";
import { runsDir } from "../util/paths.js";
import type { ClaudeResult } from "../driver/spawn.js";

/** Persist the full result of a resume run to ~/.claudify/runs for the record. */
export function saveRun(sessionId: string, prompt: string, result: ClaudeResult): string {
  fs.mkdirSync(runsDir(), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(runsDir(), `${ts}-${sessionId.slice(0, 8)}.json`);
  const payload = {
    at: new Date().toISOString(),
    sessionId,
    prompt,
    ok: result.ok,
    isError: result.isError,
    apiErrorStatus: result.apiErrorStatus,
    isAuthError: result.isAuthError,
    numTurns: result.numTurns,
    costUsd: result.costUsd,
    terminalReason: result.terminalReason,
    timedOut: result.timedOut,
    permissionDenials: result.permissionDenials,
    resultText: result.resultText,
    exitCode: result.exitCode,
    rawStderr: result.rawStderr?.slice(0, 4000) ?? "",
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}
