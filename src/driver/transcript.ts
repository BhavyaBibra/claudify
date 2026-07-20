/**
 * Reading Claude Code session transcripts (`~/.claude/projects/<dir>/<uuid>.jsonl`).
 * All JSONL-format knowledge lives here and in limit.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { projectsDir } from "../util/paths.js";
import { looksLikeLimitMessage, parseLimitMessage, type ParsedLimit } from "./limit.js";

export interface SessionInfo {
  sessionId: string;
  transcriptPath: string;
  /** Real project directory, read from the transcript's `cwd` field. */
  project: string;
  /** ISO timestamp of the last record (falls back to file mtime). */
  lastActivity: string;
  /**
   * The title the Claude app shows for this session: a user-set `custom-title`
   * if present, else the auto-generated `ai-title`, else a first-message
   * fallback. This is what the user recognizes the session by.
   */
  title: string;
  /** True when `title` is a real Claude-app title (not the fallback). */
  hasRealTitle: boolean;
  /** First human message, trimmed for display. */
  summary: string;
  sizeBytes: number;
}

export interface LimitEvent {
  parsed: ParsedLimit;
  rawText: string;
  /** ISO timestamp of the limit record, if present. */
  at: string | null;
}

interface RawRecord {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isApiErrorMessage?: boolean;
  customTitle?: string;
  aiTitle?: string;
  message?: { role?: string; content?: unknown };
}

/** Extract plain text from a record's `message.content` (string or blocks). */
function messageText(rec: RawRecord): string {
  const content = rec.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text ?? "") : ""))
      .join(" ")
      .trim();
  }
  return "";
}

function safeParse(line: string): RawRecord | null {
  try {
    return JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
}

/** Read up to `maxBytes` from the end of a file and return complete-ish lines. */
export function readTailLines(filePath: string, maxBytes = 128 * 1024): string[] {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    // If we started mid-file, drop the first (likely partial) line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split("\n").filter((l) => l.trim().length > 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the first `n` non-empty lines of a file. */
function readHeadLines(filePath: string, n: number): string[] {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.toString("utf8", 0, read).split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function firstUserSummary(filePath: string): string {
  for (const line of readHeadLines(filePath, 40)) {
    const rec = safeParse(line);
    if (rec?.type === "user") {
      const text = messageText(rec).replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<")) return text.slice(0, 80);
    }
  }
  return "(no summary)";
}

function projectCwd(filePath: string, fallbackDirName: string): string {
  for (const line of readHeadLines(filePath, 40)) {
    const rec = safeParse(line);
    if (rec?.cwd) return rec.cwd;
  }
  return fallbackDirName;
}

/**
 * Find the session's display title from `custom-title` / `ai-title` records.
 * A user-set custom title wins over the AI-generated one; the latest of each
 * wins (titles get re-emitted as they change). Scans head+tail so it works on
 * large transcripts without reading the whole file.
 */
function findTitle(headLines: string[], tailLines: string[]): { custom?: string; ai?: string } {
  let custom: string | undefined;
  let ai: string | undefined;
  for (const line of [...headLines, ...tailLines]) {
    if (!line.includes("-title")) continue; // cheap pre-filter
    const rec = safeParse(line);
    if (rec?.type === "custom-title" && rec.customTitle) custom = rec.customTitle;
    else if (rec?.type === "ai-title" && rec.aiTitle) ai = rec.aiTitle;
  }
  return { custom, ai };
}

/** Metadata for a single transcript file. */
export function inspectSession(filePath: string): SessionInfo | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const sessionId = path.basename(filePath, ".jsonl");
  const dirName = path.basename(path.dirname(filePath));
  const project = projectCwd(filePath, dirName);

  const headLines = readHeadLines(filePath, 60);
  let tailLines: string[] = [];
  let lastActivity = stat.mtime.toISOString();
  try {
    tailLines = readTailLines(filePath, 64 * 1024);
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const rec = safeParse(tailLines[i]);
      if (rec?.timestamp) {
        lastActivity = rec.timestamp;
        break;
      }
    }
  } catch {
    // keep mtime fallback
  }

  const summary = firstUserSummary(filePath);
  const { custom, ai } = findTitle(headLines, tailLines);
  const realTitle = custom ?? ai;

  return {
    sessionId,
    transcriptPath: filePath,
    project,
    lastActivity,
    title: realTitle ?? summary,
    hasRealTitle: Boolean(realTitle),
    summary,
    sizeBytes: stat.size,
  };
}

/** Enumerate all sessions across all projects, newest activity first. */
export function listSessions(): SessionInfo[] {
  const dir = projectsDir();
  let projectDirs: string[] = [];
  try {
    projectDirs = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const pd of projectDirs) {
    const full = path.join(dir, pd);
    let entries: string[] = [];
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const info = inspectSession(path.join(full, f));
      if (info) out.push(info);
    }
  }
  out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return out;
}

/**
 * Look at the tail of a transcript and return a limit event if the most recent
 * meaningful assistant record is a usage-limit message. Returns null otherwise.
 */
export function findLimitEvent(filePath: string): LimitEvent | null {
  let tail: string[];
  try {
    tail = readTailLines(filePath);
  } catch {
    return null;
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = safeParse(tail[i]);
    if (!rec) continue;
    if (rec.type !== "assistant" && rec.type !== "user") continue;

    const text = messageText(rec);
    const isLimit =
      rec.type === "assistant" &&
      (rec.isApiErrorMessage === true || looksLikeLimitMessage(text));

    if (isLimit) {
      const parsed = parseLimitMessage(text);
      if (parsed) {
        return { parsed, rawText: text, at: rec.timestamp ?? null };
      }
      // Recognized as a limit-ish message but unparseable — signal via null parsed.
      if (looksLikeLimitMessage(text)) {
        return { parsed: { kind: "unknown", timeStr: "", tz: "" }, rawText: text, at: rec.timestamp ?? null };
      }
    }
    // The newest real assistant/user turn is NOT a limit message -> not blocked.
    if (rec.type === "assistant" && text) return null;
  }
  return null;
}

/** Byte size of a transcript (used to detect that a resume actually wrote turns). */
export function transcriptSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return -1;
  }
}
