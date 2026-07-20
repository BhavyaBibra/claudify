/**
 * macOS launchd integration: install/remove/start/stop a user LaunchAgent that
 * keeps the Claudify daemon running (RunAtLoad + KeepAlive).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudifyHome } from "../util/paths.js";
import { augmentedPath } from "../driver/claudeBin.js";

export const LAUNCHD_LABEL = "com.claudify.daemon";

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function isDarwin(): boolean {
  return os.platform() === "darwin";
}

/** Resolve the absolute path to the installed `claudify` executable. */
function claudifyBinPath(): string {
  // dist/index.js is this file's ../.. at runtime; resolve via argv for robustness.
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (entry && fs.existsSync(entry)) return entry;
  return "claudify";
}

function nodePath(): string {
  return process.execPath;
}

export function buildPlist(): string {
  const home = claudifyHome();
  const outLog = path.join(home, "daemon.out.log");
  const errLog = path.join(home, "daemon.err.log");
  const args = [nodePath(), claudifyBinPath(), "daemon", "run"];
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(augmentedPath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function installAgent(): string {
  if (!isDarwin()) throw new Error("launchd install is only supported on macOS.");
  fs.mkdirSync(claudifyHome(), { recursive: true });
  const p = plistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buildPlist());
  return p;
}

export function loadAgent(): void {
  const p = plistPath();
  // bootout first to pick up changes; ignore failure if not loaded.
  try {
    execFileSync("launchctl", ["bootout", `gui/${os.userInfo().uid}`, p], { stdio: "ignore" });
  } catch {
    // not loaded — fine
  }
  execFileSync("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, p], { stdio: "inherit" });
}

export function unloadAgent(): void {
  const p = plistPath();
  try {
    execFileSync("launchctl", ["bootout", `gui/${os.userInfo().uid}`, p], { stdio: "inherit" });
  } catch {
    // already stopped
  }
}

export function removeAgent(): void {
  const p = plistPath();
  if (fs.existsSync(p)) fs.rmSync(p);
}

export function agentInstalled(): boolean {
  return fs.existsSync(plistPath());
}

export function agentPlistPath(): string {
  return plistPath();
}
