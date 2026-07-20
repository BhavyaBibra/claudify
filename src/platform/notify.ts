import { execFile } from "node:child_process";
import os from "node:os";

/**
 * Best-effort desktop notification. macOS uses osascript; other platforms just
 * log to stderr. Never throws.
 */
export function notify(title: string, message: string, enabled = true): void {
  if (!enabled) return;
  if (os.platform() === "darwin") {
    const script = `display notification ${quote(message)} with title ${quote(title)}`;
    execFile("osascript", ["-e", script], (err) => {
      if (err) console.error(`[notify] ${title}: ${message}`);
    });
  } else {
    console.error(`[notify] ${title}: ${message}`);
  }
}

/** AppleScript string quoting: wrap in quotes and escape backslashes/quotes. */
function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
