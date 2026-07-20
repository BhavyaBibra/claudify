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
    console.log("Automatic daemon management needs macOS/launchd.");
    console.log("On other platforms, run `claudify daemon run` under your own process manager.");
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
