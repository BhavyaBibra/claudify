import { execFile } from "node:child_process";
import os from "node:os";

/**
 * Best-effort desktop notification, cross-platform:
 *  - macOS   : osascript
 *  - Windows : PowerShell balloon (System.Windows.Forms, no extra module)
 *  - Linux   : notify-send if available
 * Any failure falls back to a stderr line. Never throws.
 */
export function notify(title: string, message: string, enabled = true): void {
  if (!enabled) return;
  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const script = `display notification ${q(message)} with title ${q(title)}`;
      execFile("osascript", ["-e", script], (err) => err && fallback(title, message));
      return;
    }
    if (platform === "win32") {
      // A self-disposing balloon tip; avoids third-party modules.
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$n = New-Object System.Windows.Forms.NotifyIcon;",
        "$n.Icon = [System.Drawing.SystemIcons]::Information;",
        `$n.BalloonTipTitle = ${psStr(title)};`,
        `$n.BalloonTipText = ${psStr(message)};`,
        "$n.Visible = $true; $n.ShowBalloonTip(6000); Start-Sleep -Seconds 6; $n.Dispose();",
      ].join(" ");
      execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], (err) => err && fallback(title, message));
      return;
    }
    // linux / other
    execFile("notify-send", [title, message], (err) => err && fallback(title, message));
  } catch {
    fallback(title, message);
  }
}

function fallback(title: string, message: string): void {
  console.error(`[notify] ${title}: ${message}`);
}

/** AppleScript string quoting. */
function q(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** PowerShell single-quoted string literal (double any embedded single quotes). */
function psStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
