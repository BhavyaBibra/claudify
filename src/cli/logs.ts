import fs from "node:fs";
import { readLog } from "../util/log.js";
import { logPath } from "../util/paths.js";

export interface LogFlags {
  follow?: boolean;
  lines?: number;
}

function fmt(entry: { ts?: string; level?: string; event?: string; [k: string]: unknown }): string {
  const { ts, level, event, ...rest } = entry;
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  return `${ts ?? ""}  ${(level ?? "info").toUpperCase().padEnd(5)}  ${event ?? ""}${extra}`;
}

export function runLogs(flags: LogFlags): void {
  const entries = readLog(flags.lines ?? 100);
  if (entries.length === 0) {
    console.log("No log entries yet.");
  } else {
    for (const e of entries) console.log(fmt(e));
  }

  if (!flags.follow) return;

  const p = logPath();
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    size = 0;
  }
  console.log("\n-- following (Ctrl-C to stop) --");
  fs.watchFile(p, { interval: 1000 }, () => {
    try {
      const stat = fs.statSync(p);
      if (stat.size > size) {
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(stat.size - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        size = stat.size;
        for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
          try {
            console.log(fmt(JSON.parse(line)));
          } catch {
            console.log(line);
          }
        }
      }
    } catch {
      // file may not exist yet
    }
  });
}
