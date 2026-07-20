import fs from "node:fs";
import path from "node:path";
import { claudifyHome, logPath } from "./paths.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

/** Append a structured JSONL line to the Claudify log and echo a human line. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, event, ...fields };
  try {
    fs.mkdirSync(claudifyHome(), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never crash the daemon.
  }
  const human = `[${entry.ts}] ${level.toUpperCase()} ${event}` +
    (Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "");
  if (level === "error") console.error(human);
  else console.error(human); // daemon logs go to stderr so stdout stays clean
}

export const logger = {
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};

/** Read the tail of the log file as parsed entries (best effort). */
export function readLog(maxLines = 200): LogEntry[] {
  try {
    const raw = fs.readFileSync(logPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines
      .slice(-maxLines)
      .map((l) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          return { ts: "", level: "info", event: l } as LogEntry;
        }
      });
  } catch {
    return [];
  }
}

export function logFileExists(): boolean {
  return fs.existsSync(logPath());
}

export function ensureLogDir(): void {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
}
