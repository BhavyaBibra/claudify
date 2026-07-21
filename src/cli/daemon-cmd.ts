import {
  installAgent,
  loadAgent,
  unloadAgent,
  removeAgent,
  agentInstalled,
  agentPlistPath,
  isDarwin,
  LAUNCHD_LABEL,
} from "../platform/launchd.js";
import { startDaemon } from "../daemon/daemon.js";

/** `claudify daemon run` — run the loop in the foreground (also the launchd entry). */
export function runDaemonForeground(): void {
  const handle = startDaemon();
  // Keep the process alive; the loop schedules itself via timers.
  // A no-op interval prevents Node from exiting when no timer is pending briefly.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = () => {
    handle.stop();
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function runDaemonInstall(): void {
  if (!isDarwin()) {
    console.log("Auto-start install is macOS-only for now (uses launchd).");
    console.log("Claudify still works here — keep the daemon running with:");
    console.log("    claudify daemon run");
    if (process.platform === "win32") {
      console.log("\nTo start it automatically on Windows, register that command with Task Scheduler");
      console.log("(Create Task → Trigger: At log on → Action: `claudify daemon run`).");
    } else {
      console.log("\nTo start it automatically on Linux, add a systemd user service running");
      console.log("`claudify daemon run` (or add it to your session autostart).");
    }
    return;
  }
  const p = installAgent();
  loadAgent();
  console.log(`Installed and started launchd agent ${LAUNCHD_LABEL}.`);
  console.log(`  plist: ${p}`);
  console.log("The daemon now runs at login and restarts if it crashes.");
}

export function runDaemonStart(): void {
  if (!agentInstalled()) {
    console.log("Agent not installed. Run `claudify daemon install` first.");
    return;
  }
  loadAgent();
  console.log("Daemon started.");
}

export function runDaemonStop(): void {
  unloadAgent();
  console.log("Daemon stopped.");
}

export function runDaemonUninstall(): void {
  unloadAgent();
  removeAgent();
  console.log("Daemon stopped and launchd agent removed.");
}

export function runDaemonStatus(): void {
  console.log(`launchd agent installed: ${agentInstalled() ? "yes" : "no"}`);
  if (agentInstalled()) console.log(`  plist: ${agentPlistPath()}`);
  if (!isDarwin()) console.log("  (non-macOS: manage the daemon with your own process manager)");
}
